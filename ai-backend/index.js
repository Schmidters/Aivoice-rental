// ai-backend/index.js
/**
 * AI Voice Rental — V4 (DB as source of truth)
 * - Redis only for SSE/live pings
 * - Postgres (Prisma) is canonical storage for leads, properties, messages, bookings
 */

import express from "express";
import bodyParser from "body-parser";
import Redis from "ioredis";
import OpenAI from "openai";
import twilio from "twilio";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
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
app.use(bodyParser.urlencoded({ extended: true })); // Twilio posts form-encoded
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
  try { await redis.hincrby(ANALYTICS_KEY, field, 1); } catch {}
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

// Redis-only keys for live events / modes
const convModeKey = (phone) => `conv:${phone}:mode`; // "auto" | "human"
const convHandoffReasonKey = (phone) => `conv:${phone}:handoff_reason`;
const convOwnerKey = (phone) => `conv:${phone}:owner`;
const leadHistoryKey = (phone) => `lead:${phone}:history`; // list of {t, role, content, meta?}

const publishLeadEvent = async (phone, payload) => {
  try { await redis.publish(`events:lead:${phone}`, JSON.stringify(payload)); } catch (e) { console.error(e); }
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
  const msg = await prisma.message.create({
    data: {
      role,
      content,
      meta: meta || undefined,
      leadId: lead.id,
      propertyId: prop?.id ?? null,
    },
  });
  return msg;
}

function extractSlugFromText(text) {
  if (!text) return "";
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) {
    try {
      const parts = urlMatch[0].split("/");
      const last = parts[parts.length - 1] || "";
      const slug = slugify(last);
      if (slug) return slug;
    } catch {}
  }
  const addrMatch = text.match(
    /\b\d{2,6}\s+[a-z0-9 ]+(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|trail|terrace|ter|place|pl|court|ct)\b.*?(?:calgary|edmonton|ab|alberta)?/i
  );
  if (addrMatch) {
    const slug = slugify(addrMatch[0]);
    if (slug) return slug;
  }
  return "";
}

async function findBestPropertyForLeadFromDB(phone) {
  const lead = await prisma.lead.findUnique({
    where: { phone },
    include: { properties: { include: { property: true } } },
  });
  if (lead?.properties?.length) {
    // simple "last updated" heuristic via messages/bookings
    const propIds = lead.properties.map((lp) => lp.propertyId);
    const prop = await prisma.property.findFirst({
      where: { id: { in: propIds } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });
    return prop;
  }
  return null;
}

// ---- Intent + AI reply (unchanged behavior) ----
const INTENT_LABELS = [
  "book_showing","pricing_question","availability","parking","pets",
  "application_process","negotiation","general_info","spam_or_unknown",
];
async function detectIntent(text) {
  try {
    const sys = `Classify into: ${INTENT_LABELS.join(", ")}. Return ONLY the label.`;
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0,
      messages: [{ role: "system", content: sys }, { role: "user", content: text || "" }],
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
  if (!lines.length) lines.push(`- slug: ${property.slug}`);
  return `Property Info:\n${lines.join("\n")}`;
}
async function aiReply({ incomingText, property, intent }) {
  const context = buildContextFromProperty(property);
  const system = `
You are a warm, human-sounding leasing assistant for a property management company.
Never say you're an AI. Be concise (1–2 sentences) and proactive. Use any property facts verbatim.`;
  try {
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.4,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `${context}\n\nLead intent: ${intent}\nLead message: ${incomingText}` },
      ],
    });
    return resp.choices?.[0]?.message?.content?.trim() || "Thanks for reaching out!";
  } catch {
    return "Hey! Thanks for reaching out — when would you like to see the place?";
  }
}

// ---------- TWILIO SEND ----------
async function sendSms(to, body) {
  const msg = { to, body };
  if (TWILIO_MESSAGING_SERVICE_SID) msg.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
  else msg.from = TWILIO_FROM_NUMBER;
  return twilioClient.messages.create(msg);
}

// ---------- ROUTES ----------

// Inbound SMS
app.post("/twilio/sms", async (req, res) => {
  try {
    const from = normalizePhone(req.body.From);
    const body = (req.body.Body || "").trim();
    console.log("📩 Inbound SMS:", from, body);
    if (!from || !body) return res.status(200).send("");

    await incCounter("inbound_sms");

    // 1) Upsert lead + save inbound message to DB
    const lead = await upsertLeadByPhone(from);
    let property = await findBestPropertyForLeadFromDB(from);

    // 2) Try linking property from the incoming text (URL or address)
    const possibleSlug = extractSlugFromText(body);
    if (possibleSlug) {
      const prop = await upsertPropertyBySlug(possibleSlug);
      await linkLeadToProperty(lead.id, prop.id);
      property = prop; // becomes current context
      console.log(`🏷️ Linked lead ${from} → property ${possibleSlug}`);
    }

    // 3) Persist message (role=user)
    await saveMessage({ phone: from, role: "user", content: body, meta: null, propertySlug: property?.slug });

    // 4) Intent (handoff disabled for now by design choice)
    const intent = await detectIntent(body);
    console.log("🎯 Detected intent:", intent);

    // 5) AI reply
    const reply = await aiReply({ incomingText: body, property, intent });
    await saveMessage({ phone: from, role: "assistant", content: reply, meta: null, propertySlug: property?.slug });
    await sendSms(from, reply);
    await incCounter("replied_sms");
    console.log("✅ SMS sent to lead:", from);

    // 6) Simple booking parser → persist to DB (+ optional SSE)
    if (/\b(book|schedule|showing|tour|appointment)\b/i.test(body)) {
      try {
        const dt = new Date();
        if (/\btomorrow\b/i.test(body)) dt.setDate(dt.getDate() + 1);
        const timeMatch = body.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
        if (timeMatch) {
          let h = parseInt(timeMatch[1]);
          const m = parseInt(timeMatch[2] || "0");
          const mer = timeMatch[3]?.toLowerCase();
          if (mer === "pm" && h < 12) h += 12;
          if (mer === "am" && h === 12) h = 0;
          dt.setHours(h, m, 0, 0);
        }
        const iso = dt.toISOString();

        // ensure property context exists (fallback to slug=unknown)
        const propertySlug = property?.slug || "unknown";
        const prop = await upsertPropertyBySlug(propertySlug);
        await linkLeadToProperty(lead.id, prop.id);

        const booking = await prisma.booking.create({
          data: {
            datetime: new Date(iso),
            source: "ai",
            leadId: lead.id,
            propertyId: prop.id,
          },
          include: { lead: true, property: true },
        });

        // Optional: Redis pub for live calendar SSE
        await redis.publish("bookings:new", JSON.stringify({
          id: booking.id,
          phone: booking.lead.phone,
          property: booking.property.slug,
          datetime: booking.datetime.toISOString(),
          source: booking.source,
        }));

        console.log("📅 Logged booking (DB):", {
          id: booking.id,
          phone: booking.lead.phone,
          property: booking.property.slug,
          datetime: booking.datetime.toISOString(),
        });
      } catch (e) {
        console.error("Booking parse error:", e);
      }
    }

    res.status(200).send("");
  } catch (err) {
    console.error("❌ SMS webhook error:", err);
    await incCounter("errors_sms");
    res.status(200).send("");
  }
});

// --- Zapier → /init/facts (store PropertyFacts + lead link + Redis cache) ---
app.post("/init/facts", async (req, res) => {
  try {
    const { leadPhone, leadName, property, unit, link, slug } = req.body || {};

    if (!leadPhone || !property) {
      return res.status(400).json({ ok: false, error: "Missing leadPhone or property" });
    }

    console.log("📦 Received property facts:", req.body);

    // Normalize phone
    const phone = normalizePhone(leadPhone);
    const resolvedSlug = slug || slugify(link?.split("/").pop() || property);

    // 1️⃣ Ensure lead exists
    const lead = await upsertLeadByPhone(phone);

    // 2️⃣ Ensure property exists
    const prop = await upsertPropertyBySlug(resolvedSlug, property);

    // 3️⃣ Link lead ↔ property
    await linkLeadToProperty(lead.id, prop.id);

    // 4️⃣ Save facts in Redis for fast lookup
    await redis.hset(`facts:${resolvedSlug}`, {
      leadPhone: phone,
      leadName: leadName || "",
      property,
      unit: unit || "",
      link: link || "",
      slug: resolvedSlug,
      createdAt: new Date().toISOString(),
    });

    // 5️⃣ Persist into Postgres PropertyFacts table
    await prisma.propertyFacts.upsert({
      where: { slug: resolvedSlug },
      update: {
        leadPhone: phone,
        leadName,
        property,
        unit,
        link,
      },
      create: {
        slug: resolvedSlug,
        leadPhone: phone,
        leadName,
        property,
        unit,
        link,
      },
    });

    console.log("💾 Saved PropertyFacts in DB and Redis:", resolvedSlug);

    res.json({ ok: true, slug: resolvedSlug });
  } catch (err) {
    console.error("❌ /init/facts error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});



    console.log(`💾 Stored property facts for ${prop.slug}`);
    res.json({ ok: true, slug: prop.slug });
  } catch (err) {
    console.error("❌ /init/facts error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
// ---------- READ APIs FOR DASHBOARD ----------

// Bookings list (for calendar)
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
      property: b.property.slug,
      datetime: b.datetime.toISOString(),
      source: b.source,
      createdAt: b.createdAt.toISOString(),
    }));
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Live bookings SSE (optional)
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
    try { sub.disconnect(); } catch {}
  });
});

// Health
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
  console.log(`🚀 V4 DB-first backend on :${PORT} (${NODE_ENV})`);
});
