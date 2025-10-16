// --- ai-backend/index.js ---
// Version: V5.3 — Ava (Timezone-Aware Leasing Assistant)

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
  DASHBOARD_ORIGIN = "*",
} = process.env;

const TWILIO_FROM_NUMBER = ENV_TWILIO_FROM_NUMBER || TWILIO_PHONE_NUMBER;

// ---------- CORE ----------
if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
if (!REDIS_URL) throw new Error("Missing REDIS_URL");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
const redis = new Redis(REDIS_URL, { lazyConnect: false });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ---------- HELPERS ----------
const normalizePhone = (num) => {
  if (!num) return "";
  let s = String(num).trim();
  if (!s.startsWith("+")) s = "+1" + s.replace(/[^\d]/g, "");
  return s;
};
const slugify = (s) =>
  (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)+/g, "");

// --- Timezone helpers ---
function resolveTimezoneFromAddress(address = "") {
  const a = address.toLowerCase();
  if (a.includes("calgary") || a.includes("edmonton") || a.includes("alberta")) return "America/Edmonton";
  if (a.includes("vancouver") || a.includes("british columbia")) return "America/Vancouver";
  if (a.includes("toronto") || a.includes("ontario")) return "America/Toronto";
  if (a.includes("montreal") || a.includes("quebec")) return "America/Toronto";
  return "America/Edmonton"; // default
}

function nowIso(zone = "America/Edmonton") {
  return DateTime.now().setZone(zone).toISO();
}

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
async function saveMessage({ phone, role, content, propertySlug }) {
  const lead = await upsertLeadByPhone(phone);
  const prop = propertySlug ? await upsertPropertyBySlug(propertySlug) : null;
  return prisma.message.create({
    data: {
      role,
      content,
      leadId: lead.id,
      propertyId: prop?.id ?? null,
    },
  });
}

// --- Context helpers ---
async function buildConversationContext(phone, limit = 10) {
  const messages = await prisma.message.findMany({
    where: { lead: { phone } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  if (!messages.length) return "";
  const history = messages.reverse();
  return history
    .map((m) => `${m.role === "user" ? "Lead" : "Assistant"}: ${m.content}`)
    .join("\n");
}

async function findBestPropertyForLeadFromDB(phone) {
  const lead = await prisma.lead.findUnique({
    where: { phone },
    include: { properties: { include: { property: true } } },
  });
  if (lead?.properties?.length) {
    const propIds = lead.properties.map((lp) => lp.propertyId);
    const prop = await prisma.property.findFirst({
      where: { id: { in: propIds } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });
    return prop;
  }
  return null;
}

// --- Heuristic: booking/time detection ---
function maybeContainsTimeOrBooking(text = "") {
  const t = text.toLowerCase();
  const keywords = [
    "book", "booking", "schedule", "showing", "tour", "view", "viewing",
    "see the place", "come by", "visit"
  ];
  const dayWords = [
    "today","tomorrow","tonight","morning","afternoon","evening",
    "monday","tuesday","wednesday","thursday","friday","saturday","sunday"
  ];
  const hasKeyword = keywords.some(k => t.includes(k)) || dayWords.some(d => t.includes(d));
  const timeLike = /\b(\d{1,2})(:\d{2})?\s?(am|pm)\b/i.test(text);
  return hasKeyword || timeLike;
}

// --- Extract date/time ---
async function extractDateTime(text) {
  try {
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Extract a single datetime from the user's text and return ONLY an ISO 8601 string. Assume the user's timezone is America/Edmonton. If unclear, return 'null'.",
        },
        { role: "user", content: text },
      ],
    });
    const iso = resp.choices?.[0]?.message?.content?.trim();
    if (!iso || iso.toLowerCase().includes("null")) return null;
    const dt = DateTime.fromISO(iso, { zone: "America/Edmonton" });
    return dt.isValid ? dt.toJSDate() : null;
  } catch {
    return null;
  }
}

// ---------- AI INTENT + REPLY ----------
const INTENT_LABELS = [
  "book_showing", "pricing_question", "availability", "parking", "pets",
  "application_process", "negotiation", "general_info", "spam_or_unknown",
];

async function detectIntent(text) {
  if (maybeContainsTimeOrBooking(text)) return "book_showing";
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
  return `Property Info:\n${lines.join("\n")}`;
}

// --- AI Reply (Ava) ---
async function aiReply({ incomingText, property, intent, history }) {
  const context = buildContextFromProperty(property);
  const system = `
You are Ava, a warm, intelligent leasing assistant for Real Estate Advisors.
You sound natural, professional, and remember context from prior messages.
You never mention being an AI.
You always use available facts or prior context — never make things up.
Be concise (1–2 sentences) and proactive.
`;

  const userPrompt = `
${context ? context + "\n\n" : ""}
Recent conversation:
${history || "(no prior messages)"}

Lead intent: ${intent}
Lead message: "${incomingText}"
`;

  try {
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.4,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
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

// /init/facts (Zapier)
app.post("/init/facts", async (req, res) => {
  try {
    const { leadPhone, leadName, property, unit, link, slug } = req.body || {};
    if (!leadPhone || !property)
      return res.status(400).json({ ok: false, error: "Missing leadPhone or property" });

    console.log("📦 Received property facts:", req.body);

    const phone = normalizePhone(leadPhone);
    const resolvedSlug = slug || slugify(link?.split("/").pop() || property);
    const timezone = resolveTimezoneFromAddress(property);
    const lead = await upsertLeadByPhone(phone);
    const prop = await upsertPropertyBySlug(resolvedSlug, property);
    await linkLeadToProperty(lead.id, prop.id);

    await redis.hset(`facts:${resolvedSlug}`, {
      leadPhone: phone,
      leadName: leadName || "",
      property,
      unit: unit || "",
      link: link || "",
      slug: resolvedSlug,
      timezone,
      createdAt: nowIso(timezone),
    });

    await prisma.propertyFacts.upsert({
      where: { slug: resolvedSlug },
      update: { leadPhone: phone, leadName, property, unit, link },
      create: { slug: resolvedSlug, leadPhone: phone, leadName, property, unit, link },
    });

    console.log(`💾 Saved PropertyFacts: ${resolvedSlug} [${timezone}]`);
    res.json({ ok: true, slug: resolvedSlug });
  } catch (err) {
    console.error("❌ /init/facts error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// /twilio/sms (Inbound)
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
    const history = await buildConversationContext(from);

    let reply = await aiReply({ incomingText, property, intent, history });

    // Save conversation
    await saveMessage({ phone: from, role: "user", content: incomingText, propertySlug: property?.slug });
    await saveMessage({ phone: from, role: "assistant", content: reply, propertySlug: property?.slug });

    // Booking detection
    if (intent === "book_showing") {
      const when = await extractDateTime(incomingText);
      if (when) {
        const tz = resolveTimezoneFromAddress(property?.address || "");
        const localized = DateTime.fromJSDate(when).setZone(tz);
        const booking = await prisma.booking.create({
          data: {
            leadId: lead.id,
            propertyId: property?.id ?? null,
            datetime: localized.toJSDate(),
            source: "ai",
          },
        });
        await redis.publish("bookings:new", JSON.stringify({
          id: booking.id,
          phone: lead.phone,
          property: property?.slug ?? "unknown",
          datetime: localized.toISO(),
          timezone: tz,
          source: booking.source,
          createdAt: nowIso(tz),
        }));

        const pretty = localized.toFormat("cccc, LLL d 'at' h:mm a");
        reply = `Perfect — you're booked for ${pretty} at ${property?.address || "the property"}. See you then!`;
        await saveMessage({ phone: from, role: "assistant", content: reply, propertySlug: property?.slug });
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

// Health
app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const pong = await redis.ping();
    res.json({ ok: true, db: true, redis: pong === "PONG", time: nowIso() });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Ava V5.3 running on :${PORT} (${NODE_ENV})`);
});
