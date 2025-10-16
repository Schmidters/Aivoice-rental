// ai-backend/index.js
/**
 * AI Voice Rental — V4.1 (DB-first + Auto Bookings)
 * - Redis only for SSE/live pings
 * - Postgres (Prisma) is canonical storage for leads, properties, messages, bookings, property facts
 */

import express from "express";
import bodyParser from "body-parser";
import Redis from "ioredis";
import OpenAI from "openai";
import twilio from "twilio";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { DateTime } from "luxon";
dotenv.config();

const prisma = new PrismaClient();

// ---------- ENV ----------
const {
  PORT = 3000,
  NODE_ENV = "production",
  REDIS_URL,
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_MESSAGING_SERVICE_SID,
  TWILIO_PHONE_NUMBER,
  TWILIO_FROM_NUMBER: ENV_TWILIO_FROM_NUMBER,
  HANDOFF_ENABLED: ENV_HANDOFF_ENABLED,
  DASHBOARD_ORIGIN = "*",
} = process.env;

const TWILIO_FROM_NUMBER = ENV_TWILIO_FROM_NUMBER || TWILIO_PHONE_NUMBER;
const HANDOFF_ENABLED = String(ENV_HANDOFF_ENABLED ?? "true") === "true";

// ---------- GUARDS ----------
if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
if (!REDIS_URL) throw new Error("Missing REDIS_URL");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN)
  throw new Error("Missing Twilio credentials");
if (!TWILIO_MESSAGING_SERVICE_SID && !TWILIO_FROM_NUMBER)
  throw new Error("Provide TWILIO_MESSAGING_SERVICE_SID or TWILIO_PHONE_NUMBER/TWILIO_FROM_NUMBER");

// ---------- CORE ----------
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Simple logs
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// CORS (for dashboard)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", DASHBOARD_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

const redis = new Redis(REDIS_URL, { lazyConnect: false });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ---------- HELPERS ----------
const ANALYTICS_KEY = "analytics:counters";
const incCounter = async (field) => {
  try {
    await redis.hincrby(ANALYTICS_KEY, field, 1);
  } catch {}
};
const normalizePhone = (num) => {
  if (!num) return "";
  let s = String(num).trim();
  if (!s.startsWith("+")) s = "+1" + s.replace(/[^\d]/g, "");
  return s;
};
const slugify = (s) =>
  (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)+/g, "");
const nowIso = () => new Date().toISOString();

// Redis keys
const convModeKey = (phone) => `conv:${phone}:mode`;
const publishLeadEvent = async (phone, payload) => {
  try {
    await redis.publish(`events:lead:${phone}`, JSON.stringify(payload));
  } catch (e) {
    console.error(e);
  }
};

// DB helpers
async function upsertLeadByPhone(phone) {
  return prisma.lead.upsert({
    where: { phone },
    update: {},
    create: { phone },
  });
}
async function upsertPropertyBySlug(slug, address) {
  return prisma.property.upsert({
    where: { slug },
    update: address ? { address } : {},
    create: { slug, address },
  });
}
async function linkLeadToProperty(leadId, propertyId) {
  try {
    await prisma.leadProperty.upsert({
      where: { leadId_propertyId: { leadId, propertyId } },
      update: {},
      create: { leadId, propertyId },
    });
  } catch {}
}
async function saveMessage({ phone, role, content, meta, propertySlug }) {
  const lead = await upsertLeadByPhone(phone);
  let prop = null;
  if (propertySlug) {
    prop = await upsertPropertyBySlug(propertySlug);
  }
  return prisma.message.create({
    data: {
      role,
      content,
      meta: meta || undefined,
      leadId: lead.id,
      propertyId: prop?.id ?? null,
    },
  });
}

async function findBestPropertyForLeadFromDB(phone) {
  const lead = await prisma.lead.findUnique({
    where: { phone },
    include: { properties: { include: { property: true } } },
  });
  if (lead?.properties?.length) {
    const propIds = lead.properties.map((lp) => lp.propertyId);
    return prisma.property.findFirst({
      where: { id: { in: propIds } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });
  }
  return null;
}

// ---------- AI INTENT + REPLY ----------
const INTENT_LABELS = [
  "book_showing",
  "pricing_question",
  "availability",
  "parking",
  "pets",
  "application_process",
  "negotiation",
  "general_info",
  "spam_or_unknown",
];

async function detectIntent(text) {
  try {
    const sys = `Classify into: ${INTENT_LABELS.join(", ")}. Return ONLY the label.`;
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: text || "" },
      ],
    });
    const label = resp.choices?.[0]?.message?.content?.trim();
    return INTENT_LABELS.includes(label) ? label : "general_info";
  } catch {
    return "general_info";
  }
}

function buildContextFromProperty(property) {
  if (!property) return "";
  const lines = [];
  if (property.address) lines.push(`- address: ${property.address}`);
  if (property.property) lines.push(`- property: ${property.property}`);
  if (property.unit) lines.push(`- unit: ${property.unit}`);
  if (property.rent) lines.push(`- rent: ${property.rent}`);
  if (property.bedrooms) lines.push(`- bedrooms: ${property.bedrooms}`);
  if (property.bathrooms) lines.push(`- bathrooms: ${property.bathrooms}`);
  if (property.parking) lines.push(`- parking: ${property.parking}`);
  if (property.utilitiesIncluded !== undefined)
    lines.push(
      `- utilities included: ${property.utilitiesIncluded ? "yes" : "no"}`
    );
  if (property.petsAllowed !== undefined)
    lines.push(`- pets allowed: ${property.petsAllowed ? "yes" : "no"}`);
  if (property.link) lines.push(`- listing link: ${property.link}`);
  return `Property Info:\n${lines.join("\n")}`;
}

async function aiReply({ incomingText, property, intent }) {
  const context = buildContextFromProperty(property);
  const system = `
You are a friendly, professional leasing assistant.
Use the provided property facts exactly as written when answering questions.
If the answer is not in the facts, respond naturally and politely but never invent details.
Keep replies short (1–2 sentences).
Never say you're an AI.`;
  try {
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.4,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `${context}\n\nLead intent: ${intent}\nLead message: ${incomingText}`,
        },
      ],
    });
    return resp.choices?.[0]?.message?.content?.trim() || "Thanks for reaching out!";
  } catch {
    return "Hey! Thanks for reaching out — when would you like to see the place?";
  }
}

// --- Helper: Extract natural-language time for booking ---
async function extractDateTime(text) {
  try {
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Extract a date/time from the user's text. Return ONLY an ISO 8601 datetime (e.g., 2025-10-17T09:00:00-06:00), or 'null' if none found.",
        },
        { role: "user", content: text },
      ],
    });
    const iso = resp.choices?.[0]?.message?.content?.trim();
    if (!iso || iso.toLowerCase().includes("null")) return null;
    const dt = DateTime.fromISO(iso);
    return dt.isValid ? dt.toJSDate() : null;
  } catch (err) {
    console.error("extractDateTime error:", err);
    return null;
  }
}

// ---------- TWILIO SEND ----------
async function sendSms(to, body) {
  const msg = { to, body };
  if (TWILIO_MESSAGING_SERVICE_SID)
    msg.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
  else msg.from = TWILIO_FROM_NUMBER;
  return twilioClient.messages.create(msg);
}

// ---------- ROUTES ----------

// --- Zapier → /init/facts ---
app.post("/init/facts", async (req, res) => {
  try {
    const { leadPhone, leadName, property, unit, link, slug } = req.body || {};
    if (!leadPhone || !property)
      return res.status(400).json({ ok: false, error: "Missing leadPhone or property" });

    console.log("📦 Received property facts:", req.body);
    const phone = normalizePhone(leadPhone);
    const resolvedSlug = slug || slugify(link?.split("/").pop() || property);

    const lead = await upsertLeadByPhone(phone);
    const prop = await upsertPropertyBySlug(resolvedSlug, property);
    await linkLeadToProperty(lead.id, prop.id);

    const key = `facts:${resolvedSlug}`;
    const type = await redis.type(key);
    if (type !== "hash" && type !== "none") {
      console.warn(`⚠️ Redis key ${key} was type ${type}, deleting before HSET`);
      await redis.del(key);
    }

    await redis.hset(key, {
      leadPhone: phone,
      leadName: leadName || "",
      property,
      unit: unit || "",
      link: link || "",
      slug: resolvedSlug,
      createdAt: new Date().toISOString(),
    });

    const {
      rent,
      bedrooms,
      bathrooms,
      parking,
      utilities_included,
      pets_allowed,
    } = req.body;

    await prisma.propertyFacts.upsert({
      where: { slug: resolvedSlug },
      update: {
        leadPhone: phone,
        leadName,
        property,
        unit,
        link,
        rent,
        bedrooms,
        bathrooms,
        parking,
        utilitiesIncluded: utilities_included ?? undefined,
        petsAllowed: pets_allowed ?? undefined,
      },
      create: {
        slug: resolvedSlug,
        leadPhone: phone,
        leadName,
        property,
        unit,
        link,
        rent,
        bedrooms,
        bathrooms,
        parking,
        utilitiesIncluded: utilities_included ?? undefined,
        petsAllowed: pets_allowed ?? undefined,
      },
    });

    console.log("💾 Saved PropertyFacts in DB and Redis:", resolvedSlug);
    res.json({ ok: true, slug: resolvedSlug });
  } catch (err) {
    console.error("❌ /init/facts error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// --- Twilio → /twilio/sms ---
app.post("/twilio/sms", async (req, res) => {
  try {
    console.log("📩 Raw Twilio webhook body:", req.body);

    const from = normalizePhone(req.body.From);
    const incomingText = req.body.Body?.trim() || "";
    if (!from || !incomingText) return res.status(400).end();

    console.log("📩 SMS received from", from, ":", incomingText);

    const lead = await upsertLeadByPhone(from);
    const property = await findBestPropertyForLeadFromDB(from);
    const intent = await detectIntent(incomingText);
    const reply = await aiReply({ incomingText, property, intent });

    await saveMessage({ phone: from, role: "user", content: incomingText, propertySlug: property?.slug });
    await saveMessage({ phone: from, role: "assistant", content: reply, propertySlug: property?.slug });

    // --- NEW: Create booking if intent is book_showing ---
    if (intent === "book_showing") {
      const when = await extractDateTime(incomingText);
      if (when) {
        const booking = await prisma.booking.create({
          data: {
            leadId: lead.id,
            propertyId: property?.id ?? null,
            datetime: when,
            source: "ai",
          },
        });

        // Push live to dashboard
        await redis.publish("bookings:new", JSON.stringify({
          id: booking.id,
          phone: lead.phone,
          property: property?.slug ?? "unknown",
          datetime: booking.datetime,
          source: booking.source,
          createdAt: booking.createdAt,
        }));

        console.log("📆 Booking created:", when.toISOString());
      }
    }

    await sendSms(from, reply);
    console.log("💬 AI reply sent to", from, ":", reply);
    res.status(200).end();
  } catch (err) {
    console.error("❌ /twilio/sms error:", err);
    res.status(500).end();
  }
});

// --- Dashboard read APIs ---
app.get("/api/bookings", async (_req, res) => {
  try {
    const rows = await prisma.booking.findMany({
      orderBy: { datetime: "desc" },
      take: 500,
      include: { lead: true, property: true },
    });
    const items = rows.map((b) => ({
      id: b.id,
      phone: b.lead.phone,
      property: b.property?.slug,
      datetime: b.datetime.toISOString(),
      source: b.source,
      createdAt: b.createdAt.toISOString(),
    }));
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/api/bookings/events", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", DASHBOARD_ORIGIN);
  res.flushHeaders?.();

  const heartbeat = setInterval(() => {
    res.write("event: ping\n");
    res.write("data: {}\n\n");
  }, 25000);

  const sub = new Redis(REDIS_URL);
  await sub.subscribe("bookings:new");
  sub.on("message", (_ch, msg) => {
    res.write(`data: ${msg}\n\n`);
  });

  req.on("close", () => {
    clearInterval(heartbeat);
    try {
      sub.disconnect();
    } catch {}
  });
});

app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const pong = await redis.ping();
    res.json({ ok: true, db: true, redis: pong === "PONG", time: nowIso(), env: NODE_ENV });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 V4.1 backend on :${PORT} (${NODE_ENV})`);
});
