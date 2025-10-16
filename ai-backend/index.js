// --- ai-backend/index.js ---
// Version: V6.2 — Ava (DB-only + BrowseAI Facts Integration)

import express from "express";
import bodyParser from "body-parser";
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

if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
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
  const a = address?.toLowerCase?.() || "";
  if (a.includes("calgary") || a.includes("edmonton") || a.includes("alberta"))
    return "America/Edmonton";
  if (a.includes("vancouver") || a.includes("british columbia"))
    return "America/Vancouver";
  if (a.includes("toronto") || a.includes("ontario"))
    return "America/Toronto";
  if (a.includes("montreal") || a.includes("quebec"))
    return "America/Toronto";
  return "America/Edmonton";
}
function nowIso(zone = "America/Edmonton") {
  return DateTime.now().setZone(zone).toISO();
}

// ---------- DATABASE HELPERS ----------
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

async function buildConversationContext(phone, limit = 10) {
  const messages = await prisma.message.findMany({
    where: { lead: { phone } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  if (!messages.length) return "";
  const history = messages.reverse();
  return history
    .map(
      (m) => `${m.role === "user" ? "Lead" : "Assistant"}: ${m.content}`
    )
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

// ---------- BOOKING + TIME HELPERS ----------
function maybeContainsTimeOrBooking(text = "") {
  const t = text.toLowerCase();
  const keywords = [
    "book", "booking", "schedule", "showing", "tour", "view", "viewing",
    "see the place", "come by", "visit", "reschedule", "change the time", "move it"
  ];
  const dayWords = [
    "today","tomorrow","tonight","morning","afternoon","evening",
    "monday","tuesday","wednesday","thursday","friday","saturday","sunday"
  ];
  const hasKeyword =
    keywords.some((k) => t.includes(k)) || dayWords.some((d) => t.includes(d));
  const timeLike = /\b(\d{1,2})(?::?(\d{2}))?\s?(am|pm)\b/i.test(text);
  return hasKeyword || timeLike;
}

function parseQuickDateTime(text = "", tz = "America/Edmonton", baseDate = null) {
  const t = text.trim().toLowerCase();
  const now = DateTime.now().setZone(tz);
  let date = baseDate
    ? DateTime.local(baseDate.year, baseDate.month, baseDate.day, 0, 0, 0, { zone: tz })
    : DateTime.local(now.year, now.month, now.day, 0, 0, 0, { zone: tz });

  let matchedRelative = false;
  if (!baseDate) {
    if (/\btomorrow\b/.test(t)) {
      date = date.plus({ days: 1 });
      matchedRelative = true;
    } else if (/\btoday\b/.test(t)) matchedRelative = true;
    else if (/\btonight\b/.test(t)) {
      date = now.set({ hour: 19, minute: 0 });
      matchedRelative = true;
    }
  }

  const m = t.match(/\b(\d{1,2})[:\s]?(\d{2})?\s?(am|pm)\b/);
  if (m) {
    let hour = parseInt(m[1]);
    const minute = m[2] ? parseInt(m[2]) : 0;
    const meridiem = m[3].toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (baseDate) {
      date = date.set({ hour, minute });
    } else if (matchedRelative) {
      date = date.set({ hour, minute });
    } else {
      const candidate = now.set({ hour, minute });
      date = candidate < now ? candidate.plus({ days: 1 }) : candidate;
    }
  } else if ((matchedRelative || baseDate) && !/\btonight\b/.test(t)) {
    date = date.set({ hour: 10, minute: 0 });
  }
  const used = matchedRelative || m || baseDate;
  if (used) {
    const dt = DateTime.fromISO(date.toISO(), { zone: tz });
    return dt.isValid ? dt.toJSDate() : null;
  }
  return null;
}

async function extractDateTimeLLM(text, tz = "America/Edmonton", baseDate = null) {
  try {
    const nowLocal = DateTime.now().setZone(tz).toISO();
    const base = baseDate ? baseDate.toISODate() : "(none)";
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `Convert user message into a full ISO datetime in zone ${tz}.
Current: ${nowLocal}. Base date: ${base}. Return only ISO or null.`,
        },
        { role: "user", content: text },
      ],
    });
    const iso = resp.choices?.[0]?.message?.content?.trim();
    if (!iso || iso.toLowerCase().includes("null")) return null;
    const dt = DateTime.fromISO(iso, { zone: tz });
    return dt.isValid ? dt.toJSDate() : null;
  } catch {
    return null;
  }
}

// ---------- AI LOGIC ----------
const INTENT_LABELS = [
  "book_showing","pricing_question","availability","parking","pets",
  "application_process","negotiation","general_info","spam_or_unknown",
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

async function buildContextFromProperty(property) {
  if (!property) return "";
  const facts = await prisma.propertyFacts.findUnique({
    where: { propertyId: property.id },
  });

  const lines = [];
  if (property.address) lines.push(`- address: ${property.address}`);
  if (facts?.unit) lines.push(`- unit: ${facts.unit}`);
  if (facts?.rent) lines.push(`- rent: ${facts.rent}`);
  if (facts?.bedrooms) lines.push(`- bedrooms: ${facts.bedrooms}`);
  if (facts?.bathrooms) lines.push(`- bathrooms: ${facts.bathrooms}`);
  if (facts?.parking) lines.push(`- parking: ${facts.parking}`);
  if (facts?.utilities) lines.push(`- utilities: ${facts.utilities}`);
  if (facts?.summary) lines.push(`- summary: ${facts.summary}`);
  if (facts?.link) lines.push(`- listing link: ${facts.link}`);

  return lines.length ? `Property Info:\n${lines.join("\n")}` : "";
}

async function aiReply({ incomingText, property, intent, history }) {
  const context = await buildContextFromProperty(property);
  const system = `
You are Ava, a warm, intelligent leasing assistant for Real Estate Advisors.
Use only verified facts from the property database.
You sound natural, professional, and remember context from prior messages.
Never mention being an AI. Be concise (1–2 sentences) and proactive.
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

// ---------- ROUTES ----------

// /init/facts — BrowseAI data ingestion
app.post("/init/facts", async (req, res) => {
  try {
    const {
      leadPhone,
      leadName,
      property,
      unit,
      link,
      slug,
      rent,
      bedrooms,
      bathrooms,
      parking,
      utilities,
      summary,
    } = req.body || {};

    if (!leadPhone || !property)
      return res.status(400).json({ ok: false, error: "Missing leadPhone or property" });

    console.log("📦 [Init] Received property facts:", req.body);

    const phone = normalizePhone(leadPhone);
    const resolvedSlug = slug || slugify(link?.split("/").pop() || property);

    const lead = await upsertLeadByPhone(phone);
    const prop = await upsertPropertyBySlug(resolvedSlug, property);
    await linkLeadToProperty(lead.id, prop.id);

    await prisma.propertyFacts.upsert({
      where: { slug: resolvedSlug },
      update: {
        propertyName: property,
        unit,
        link,
        rent,
        bedrooms,
        bathrooms,
        parking,
        utilities,
        summary,
        leadPhone: phone,
        leadName,
        propertyId: prop.id,
      },
      create: {
        slug: resolvedSlug,
        propertyName: property,
        unit,
        link,
        rent,
        bedrooms,
        bathrooms,
        parking,
        utilities,
        summary,
        leadPhone: phone,
        leadName,
        propertyId: prop.id,
      },
    });

    console.log(`💾 [Init] Saved property facts for ${resolvedSlug}`);
    res.json({ ok: true, slug: resolvedSlug });
  } catch (err) {
    console.error("❌ /init/facts error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// /twilio/sms (Inbound)
app.post("/twilio/sms", async (req, res) => {
  try {
    const from = normalizePhone(req.body.From);
    const incomingText = req.body.Body?.trim() || "";
    if (!from || !incomingText) return res.status(400).end();

    console.log("📩 SMS received from", from, ":", incomingText);

    const lead = await upsertLeadByPhone(from);
    const property = await findBestPropertyForLeadFromDB(from);

    const tz = resolveTimezoneFromAddress(property?.address || "");
    const intent = await detectIntent(incomingText);
    const history = await buildConversationContext(from);

    await saveMessage({ phone: from, role: "user", content: incomingText, propertySlug: property?.slug });

    let reply = await aiReply({ incomingText, property, intent, history });

    if (intent === "book_showing") {
      let when = parseQuickDateTime(incomingText, tz);
      if (!when) when = await extractDateTimeLLM(incomingText, tz);
      if (when) {
        const localized = DateTime.fromJSDate(when).setZone(tz);
        const booking = await prisma.booking.create({
          data: {
            leadId: lead.id,
            propertyId: property?.id ?? null,
            datetime: localized.toJSDate(),
            source: "ai",
          },
        });
        const pretty = localized.toFormat("cccc, LLL d 'at' h:mm a");
        reply = `Perfect — you're booked for ${pretty} at ${
          property?.address || "the property"
        }. See you then!`;
        await saveMessage({
          phone: from,
          role: "assistant",
          content: reply,
          propertySlug: property?.slug,
        });
      }
    }

    await sendSms(from, reply);
    console.log("💬 AI reply sent:", reply);
    res.status(200).end();
  } catch (err) {
    console.error("❌ /twilio/sms error:", err);
    res.status(500).end();
  }
});

// ---------- HEALTH ----------
app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: true, time: nowIso() });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Ava V6.2 running (DB-only + BrowseAI Facts) on :${PORT} (${NODE_ENV})`);
});
