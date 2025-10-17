/**
 * AI Voice Rental — V4.5 (Pure DB-first, no Redis)
 * - Postgres (Prisma) is canonical storage for leads, properties, messages, bookings
 */

import express from "express";
import bodyParser from "body-parser";
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
const nowIso = () => new Date().toISOString();

// ---------- DB HELPERS ----------
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
  if (propertySlug) prop = await upsertPropertyBySlug(propertySlug);
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

// ---------- INTENT + AI ----------
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
    return (
      resp.choices?.[0]?.message?.content?.trim() ||
      "Thanks for reaching out!"
    );
  } catch {
    return "Hey! Thanks for reaching out — when would you like to see the place?";
  }
}

// ---------- TWILIO ----------
async function sendSms(to, body) {
  const msg = { to, body };
  if (TWILIO_MESSAGING_SERVICE_SID)
    msg.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
  else msg.from = TWILIO_FROM_NUMBER;
  return twilioClient.messages.create(msg);
}

// ---------- ROUTES ----------
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
        unit,
        link,
        rent,
        bedrooms,
        bathrooms,
        parking,
        utilitiesIncluded: utilities_included ?? undefined,
        petsAllowed: pets_allowed ?? undefined,
        property: { connect: { id: prop.id } },
      },
      create: {
        slug: resolvedSlug,
        leadPhone: phone,
        leadName,
        unit,
        link,
        rent,
        bedrooms,
        bathrooms,
        parking,
        utilitiesIncluded: utilities_included ?? undefined,
        petsAllowed: pets_allowed ?? undefined,
        property: { connect: { id: prop.id } },
      },
    });

    console.log("💾 Saved PropertyFacts:", resolvedSlug);
    res.json({ ok: true, slug: resolvedSlug });
  } catch (err) {
    console.error("❌ /init/facts error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: true, time: nowIso(), env: NODE_ENV });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ---------- Twilio inbound ----------
app.post("/twilio/sms", async (req, res) => {
  try {
    console.log("📩 Raw Twilio webhook body:", req.body);
    const from = normalizePhone(req.body.From);
    const incomingText = req.body.Body?.trim() || "";
    if (!from || !incomingText) return res.status(400).end();
    console.log("📩 SMS received from", from, ":", incomingText);

    let property = await findBestPropertyForLeadFromDB(from);

    // Merge in latest PropertyFacts before AI reply
    if (property?.slug) {
      const facts = await prisma.propertyFacts.findUnique({
        where: { slug: property.slug },
      });
      if (facts) Object.assign(property, facts);
    }

    const intent = await detectIntent(incomingText);

    // --- Booking intent handler ---
    if (
      intent === "book_showing" ||
      /\b(?:am|pm|tomorrow|today|\b\d{1,2}[: ]?\d{0,2}\b)\b/i.test(incomingText)
    ) {
      const { DateTime } = await import("luxon");
      let tz = "America/Edmonton";
      if (property?.address) {
        const addr = property.address.toLowerCase();
        if (addr.includes("vancouver") || addr.includes("british columbia"))
          tz = "America/Vancouver";
        else if (addr.includes("toronto") || addr.includes("ontario"))
          tz = "America/Toronto";
        else if (addr.includes("winnipeg") || addr.includes("manitoba"))
          tz = "America/Winnipeg";
        else if (addr.includes("halifax") || addr.includes("nova scotia"))
          tz = "America/Halifax";
        else if (addr.includes("saskatoon") || addr.includes("regina"))
          tz = "America/Regina";
      }

      const timeMatch = incomingText.match(
        /\b(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?\b/i
      );
      if (!timeMatch) {
        await sendSms(from, "What time works best for you? (e.g., 'Sat 10:30am')");
        return res.status(200).end();
      }

      let when = DateTime.now().setZone(tz);
      const msg = incomingText.toLowerCase();
      if (msg.includes("tomorrow")) when = when.plus({ days: 1 });
      if (msg.includes("next week")) when = when.plus({ days: 7 });

      const hour = parseInt(timeMatch[1]);
      const minute = parseInt(timeMatch[2] || "0");
      const meridian = (timeMatch[3] || "").toLowerCase();
      let hour24 = hour;
      if (meridian === "pm" && hour < 12) hour24 = hour + 12;
      if (meridian === "am" && hour === 12) hour24 = 0;

      const startAt = when.set({ hour: hour24, minute }).startOf("minute");

      const conflict = await prisma.booking.findFirst({
        where: {
          property: { id: property?.id },
          startAt: {
            gte: startAt.minus({ minutes: 30 }).toISO(),
            lte: startAt.plus({ minutes: 30 }).toISO(),
          },
          status: { in: ["pending_confirmation", "confirmed"] },
        },
      });

      if (conflict) {
        const nextSlot = startAt.plus({ minutes: 30 });
        const nextConflict = await prisma.booking.findFirst({
          where: {
            property: { id: property?.id },
            startAt: {
              gte: nextSlot.minus({ minutes: 30 }).toISO(),
              lte: nextSlot.plus({ minutes: 30 }).toISO(),
            },
            status: { in: ["pending_confirmation", "confirmed"] },
          },
        });

        if (!nextConflict) {
          await sendSms(
            from,
            `Someone’s already booked near ${startAt.toFormat(
              "ccc, LLL d 'at' h:mm a"
            )}. I can offer ${nextSlot.toFormat(
              "h:mm a"
            )} instead — does that work?`
          );
        } else {
          await sendSms(
            from,
            `Looks like that time’s taken. Would you like to try a different day or time?`
          );
        }
        return res.status(200).end();
      }

      await prisma.booking.create({
        data: {
          phone: from,
          property: property ? { connect: { id: property.id } } : undefined,
          startAt: startAt.toISO(),
          timezone: tz,
          source: "sms",
          status: "pending_confirmation",
        },
      });

      await sendSms(
        from,
        `Perfect — you're booked for ${startAt.toFormat(
          "cccc, LLL d 'at' h:mm a"
        )} (${tz.replace("America/", "")}). See you then!`
      );
      console.log(`✅ Booking created at ${startAt.toISO()} (${tz}) for ${from}`);
      return res.status(200).end();
    }

    const reply = await aiReply({ incomingText, property, intent });
    await saveMessage({ phone: from, role: "user", content: incomingText, propertySlug: property?.slug });
    await saveMessage({ phone: from, role: "assistant", content: reply, propertySlug: property?.slug });
    await sendSms(from, reply);

    console.log("💬 AI reply sent to", from, ":", reply);
    res.status(200).end();
  } catch (err) {
    console.error("❌ /twilio/sms error:", err);
    res.status(500).end();
  }
});

app.listen(PORT, () => {
  console.log(`🚀 V4.5 DB-only backend on :${PORT} (${NODE_ENV})`);
});
