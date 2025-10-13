/**
 * AI Voice Rental — Stable v1 + Intent Brain Expansion
 * ----------------------------------------------------
 * - Keeps all original webhooks (Twilio + Zapier)
 * - Adds lightweight OpenAI-based intent detection
 * - Enhances AI replies with contextual understanding
 * - No breaking changes to existing flows
 */

import express from "express";
import bodyParser from "body-parser";
import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai";
import twilio from "twilio";
import dotenv from "dotenv";
dotenv.config();

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
  TWILIO_FROM_NUMBER: ENV_TWILIO_FROM_NUMBER
} = process.env;

const TWILIO_FROM_NUMBER = ENV_TWILIO_FROM_NUMBER || TWILIO_PHONE_NUMBER;

// ---------- GUARDS ----------
if (!REDIS_URL) throw new Error("Missing REDIS_URL");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN)
  throw new Error("Missing Twilio credentials");
if (!TWILIO_MESSAGING_SERVICE_SID && !TWILIO_FROM_NUMBER)
  throw new Error("Provide TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER");

// ---------- CORE ----------
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
const redis = new Redis(REDIS_URL, { lazyConnect: false });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ---------- HELPERS ----------
const normalizePhone = (num) => {
  if (!num) return "";
  let s = num.trim();
  if (!s.startsWith("+")) s = "+1" + s.replace(/[^\d]/g, "");
  return s;
};

const slugify = (s) =>
  (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)+/g, "");

const propertyKey = (slug) => `property:${slug}`;
const nowIso = () => new Date().toISOString();

// ---------- PROPERTY STORAGE ----------
async function setPropertyContext(obj) {
  const slug = slugify(obj.slug || obj.address);
  if (!slug) throw new Error("Property slug/address required");
  const key = propertyKey(slug);
  const data = { slug, last_updated: nowIso(), ...obj };
  await redis.set(key, JSON.stringify(data), "EX", 6 * 3600);
  return data;
}

async function getPropertyContext(slug) {
  const raw = await redis.get(propertyKey(slug));
  return raw ? JSON.parse(raw) : null;
}

const leadPropsKey = (phone) => `lead:${phone}:properties`;
const perPropLeadIdx = (slug) => `property:${slug}:leads`;

async function findBestPropertyForLead(phone) {
  const props = await redis.smembers(leadPropsKey(phone));
  if (props.length) {
    let newest = null;
    for (const s of props) {
      const p = await getPropertyContext(s);
      if (p && (!newest || p.last_updated > newest.last_updated)) newest = p;
    }
    return newest;
  }
  return null;
}

// ---------- INTENT DETECTION ----------
const INTENT_LABELS = [
  "book_showing",
  "pricing_question",
  "availability",
  "parking",
  "pets",
  "application_process",
  "negotiation",
  "general_info",
  "spam_or_unknown"
];

async function detectIntent(text) {
  try {
    const sys = `Classify the user's SMS into one of these labels: ${INTENT_LABELS.join(
      ", "
    )}. Return ONLY the label.`;
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: text }
      ]
    });
    const label = resp.choices?.[0]?.message?.content?.trim();
    return INTENT_LABELS.includes(label) ? label : "general_info";
  } catch (err) {
    console.error("❌ Intent detect error:", err);
    return "general_info";
  }
}

// ---------- AI REASONING ----------
async function aiReasonFromSources(prompt, property, intent) {
  let context = "";
  if (property) {
    context = `
Property Info:
- Address: ${property.address}
- Unit: ${property.unit_type || "N/A"}
- Rent: ${property.rent || "N/A"}
- Available: ${property.available || "N/A"}
- Parking: ${property.parking || "N/A"}
- Pets: ${property.pets || "N/A"}
`;
  }

  const systemPrompt = `
You are a warm, human-sounding leasing assistant for a property management company.
Never say you're an AI. Be concise and helpful.
If intent is "${intent}", adjust tone accordingly.`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `${context}\n\nLead message: ${prompt}` }
  ];

  try {
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.5,
      messages
    });
    return resp.choices?.[0]?.message?.content?.trim() || "Thanks for reaching out!";
  } catch (err) {
    console.error("❌ OpenAI reply error:", err);
    return "Hey! Thanks for reaching out — when would you like to see the place?";
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

// Twilio inbound SMS
app.post("/twilio/sms", async (req, res) => {
  try {
    const from = normalizePhone(req.body.From);
    const body = (req.body.Body || "").trim();
    console.log("📩 Inbound SMS:", from, body);
    if (!from || !body) return res.status(200).send("");

    // Detect intent
    const intent = await detectIntent(body);
    console.log("🎯 Detected intent:", intent);

    // Try to find property context
    let property = await findBestPropertyForLead(from);

    // Auto-fallback: if no linked property, use latest cached one
    if (!property) {
      const keys = await redis.keys("property:*");
      if (keys.length) {
        const recent = keys.sort().reverse()[0];
        property = JSON.parse(await redis.get(recent));
        if (property) {
          await redis.sadd(leadPropsKey(from), property.slug);
          await redis.sadd(perPropLeadIdx(property.slug), from);
        }
      }
    }

    console.log("🏠 Property resolved:", property ? property.slug : "none");

    // Generate AI reply
    const reply = await aiReasonFromSources(body, property, intent);
    console.log("💬 AI reply generated:", reply);

    await sendSms(from, reply);
    console.log("✅ SMS sent to lead:", from);

    res.status(200).send("");
  } catch (err) {
    console.error("❌ SMS webhook error:", err);
    res.status(200).send("");
  }
});


// Zapier → Property ingest (unchanged)
app.post("/init/facts", async (req, res) => {
  try {
    const { leadPhone, property, unit, finalUrl } = req.body || {};
    const slug = slugify(property);
    if (!slug) return res.status(400).json({ ok: false, error: "Missing property" });

    const prop = await setPropertyContext({
      address: property,
      slug,
      unit_type: unit,
      source_url: finalUrl,
      lead_phone: leadPhone
    });

    if (leadPhone) {
      const phone = normalizePhone(leadPhone);
      await redis.sadd(leadPropsKey(phone), slug);
      await redis.sadd(perPropLeadIdx(slug), phone);
    }

    res.json({ ok: true, slug: prop.slug, stored: true });
  } catch (err) {
    console.error("❌ /init/facts error:", err);
    res.status(500).json({ ok: false });
  }
});

// Debug endpoints (optional)
app.get("/debug/lead", async (req, res) => {
  const phone = normalizePhone(req.query.phone || "");
  if (!phone) return res.status(400).json({ ok: false, error: "Provide ?phone=+1..." });
  const props = await redis.smembers(leadPropsKey(phone));
  res.json({ ok: true, phone, properties: props });
});

app.get("/debug/property/:slug", async (req, res) => {
  const prop = await getPropertyContext(req.params.slug);
  if (!prop) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true, prop });
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`🚀 Stable v1 + Intent Brain running on :${PORT} (${NODE_ENV})`);
});
