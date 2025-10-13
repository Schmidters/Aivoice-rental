/**
 * AI Voice Rental — v2 “AI Brain Expansion”
 * - Keeps /init/facts (Zapier v1 compatibility)
 * - Adds full inbound/outbound SMS logging
 * - Adds defensive OpenAI error handling
 */

require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const Redis = require("ioredis");
const { v4: uuidv4 } = require("uuid");
const pino = require("pino");
const OpenAI = require("openai");
const twilio = require("twilio");

// ---------- ENV ----------
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_MESSAGING_SERVICE_SID,
  TWILIO_PHONE_NUMBER,
  TWILIO_FROM_NUMBER: ENV_TWILIO_FROM_NUMBER,
  PORT = 3000,
  NODE_ENV = "production",
  REDIS_URL,
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",
  OPENAI_MODEL_SUMMARY = "gpt-4o-mini",
} = process.env;

const TWILIO_FROM_NUMBER = ENV_TWILIO_FROM_NUMBER || TWILIO_PHONE_NUMBER;

// ---------- GUARDS ----------
if (!REDIS_URL) throw new Error("Missing REDIS_URL");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN)
  throw new Error("Missing Twilio credentials (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)");
if (!TWILIO_MESSAGING_SERVICE_SID && !TWILIO_FROM_NUMBER)
  throw new Error("Provide TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER");

// ---------- CORE ----------
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const log = pino({ level: NODE_ENV === "development" ? "debug" : "info" });
const redis = new Redis(REDIS_URL, { lazyConnect: false });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ---------- CONSTANTS ----------
const MAX_HISTORY_ITEMS = 12;
const SUMMARY_AFTER = 10;
const MAX_HISTORY_TOKEN_HINT = 800;
const PROPERTY_TTL_SECONDS = 6 * 60 * 60;
const ANALYTICS_KEY = "analytics:counters";
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
const leadHistoryKey = (phone) => `lead:${phone}:history`;
const leadSummaryKey = (phone) => `lead:${phone}:summary`;
const leadIntentKey = (phone) => `lead:${phone}:intent`;
const leadPropsKey = (phone) => `lead:${phone}:properties`;
const perPropLeadIdx = (slug) => `property:${slug}:leads`;

async function incCounter(field) {
  await redis.hincrby(ANALYTICS_KEY, field, 1);
}
const nowIso = () => new Date().toISOString();
const trimText = (s, m = 300) => (!s ? "" : s.length > m ? s.slice(0, m) + "…" : s);

// ---------- MEMORY ----------
async function appendLeadHistory(phone, role, content) {
  const key = leadHistoryKey(phone);
  const item = JSON.stringify({ t: nowIso(), role, content: trimText(content, 1000) });
  await redis.lpush(key, item);
  await redis.ltrim(key, 0, MAX_HISTORY_ITEMS - 1);
}
async function getLeadHistory(phone) {
  const raw = await redis.lrange(leadHistoryKey(phone), 0, -1);
  return raw
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}
async function getLeadSummary(phone) {
  return redis.get(leadSummaryKey(phone));
}
async function setLeadSummary(phone, summary) {
  return redis.set(leadSummaryKey(phone), summary, "EX", 7 * 24 * 3600);
}
async function maybeSummarizeHistory(phone) {
  const history = await getLeadHistory(phone);
  if (history.length < SUMMARY_AFTER) return;
  const transcript = history
    .map((h) => `[${h.t}] ${h.role === "user" ? "Lead" : "Assistant"}: ${h.content}`)
    .join("\n");
  const prompt = `Summarize this SMS conversation (keep under ${MAX_HISTORY_TOKEN_HINT} tokens):\n${transcript}`;
  try {
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL_SUMMARY,
      temperature: 0.2,
      messages: [
        { role: "system", content: "You create concise, factual CRM-style summaries." },
        { role: "user", content: prompt },
      ],
    });
    const summary = resp.choices?.[0]?.message?.content?.trim();
    if (summary) await setLeadSummary(phone, summary);
  } catch (err) {
    console.error("❌ OpenAI summary error:", err);
  }
}

// ---------- PROPERTY CONTEXT ----------
async function setPropertyContext(obj) {
  const slug = slugify(obj.slug || obj.address);
  if (!slug) throw new Error("Property slug/address required");
  const key = propertyKey(slug);
  const data = { slug, last_updated: nowIso(), ...obj };
  await redis.set(key, JSON.stringify(data), "EX", PROPERTY_TTL_SECONDS);
  return data;
}
async function getPropertyContext(slug) {
  const raw = await redis.get(propertyKey(slug));
  return raw ? JSON.parse(raw) : null;
}
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

// ---------- INTENT ----------
async function detectIntent(txt) {
  try {
    const sys = `Classify the user's SMS into one label: ${INTENT_LABELS.join(
      ", "
    )}. Return ONLY the label.`;
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: txt || "" },
      ],
    });
    const label = resp.choices?.[0]?.message?.content?.trim();
    return INTENT_LABELS.includes(label) ? label : "spam_or_unknown";
  } catch (err) {
    console.error("❌ Intent detect error:", err);
    return "spam_or_unknown";
  }
}

// ---------- PROMPT ----------
function buildAgentSystemPrompt(property, summary) {
  const facts = property
    ? `
Property:
- ${property.address || property.slug}
- ${property.unit_type || "N/A"}
- Rent: ${property.rent ? `$${property.rent}` : "N/A"}
- Available: ${property.available ?? "N/A"}
- Parking: ${property.parking ?? "N/A"}
- Pets: ${property.pets ?? "N/A"}`
    : "(No property data cached yet)";
  const mem = summary ? `Lead Summary: ${summary}\n` : "";
  return `You are a friendly human leasing assistant.
${facts}
${mem}
Answer naturally, short, and helpful.`;
}

// ---------- GENERATION ----------
async function generateAssistantReply({ incomingText, property, history, summary }) {
  const system = buildAgentSystemPrompt(property, summary);
  const msgs = [{ role: "system", content: system }];
  for (const h of (history || []).slice(-6))
    msgs.push({ role: h.role === "assistant" ? "assistant" : "user", content: h.content });
  msgs.push({ role: "user", content: incomingText });
  try {
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.4,
      messages: msgs,
    });
    return resp.choices?.[0]?.message?.content?.trim() || "Thanks for reaching out!";
  } catch (err) {
    console.error("❌ OpenAI completion error:", err);
    return "Hey! Got your message — one of our team will reply shortly.";
  }
}

// ---------- TWILIO ----------
async function sendSms(to, body) {
  const msg = { to, body };
  if (TWILIO_MESSAGING_SERVICE_SID) msg.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
  else msg.from = TWILIO_FROM_NUMBER;
  const res = await twilioClient.messages.create(msg);
  return res.sid;
}

// ---------- ROUTES ----------

// Global ping logger
app.use((req, res, next) => {
  if (req.path === "/twilio/sms") console.log("🛰️ Twilio webhook hit:", req.method, req.path);
  next();
});

// Inbound SMS
app.post("/twilio/sms", async (req, res) => {
  try {
    const from = normalizePhone(req.body.From);
    const to = normalizePhone(req.body.To);
    const body = (req.body.Body || "").trim();
    console.log("📩 Inbound SMS body:", body);
    if (!from || !body) return res.status(200).send("");

    await incCounter("inbound_sms");
    await appendLeadHistory(from, "user", body);

    const property = await findBestPropertyForLead(from);
    const summary = await getLeadSummary(from);
    const history = await getLeadHistory(from);
    const intent = await detectIntent(body);
    await redis.set(leadIntentKey(from), intent, "EX", 2 * 24 * 3600);

    let reply;
    if (intent === "availability" && property?.available) {
      reply = `Yes — it's available. Want to see it ${
        property.available === "Now" ? "today or tomorrow" : `around ${property.available}`
      }? I can offer tomorrow 6pm or Saturday 2pm.`;
    } else {
      reply = await generateAssistantReply({ incomingText: body, property, history, summary });
    }

    await sendSms(from, reply);
    await appendLeadHistory(from, "assistant", reply);
    await maybeSummarizeHistory(from);
    await incCounter("replied_sms");
    console.log("✅ SMS reply sent:", reply);
    res.status(200).send("");
  } catch (err) {
    console.error("❌ SMS webhook error:", err);
    await incCounter("errors_sms");
    res.status(200).send("");
  }
});

// Zapier v1 ingest
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
      lead_phone: leadPhone,
    });
    await incCounter("property_ingest");
    if (leadPhone) {
      const phone = normalizePhone(leadPhone);
      if (phone) {
        await redis.sadd(leadPropsKey(phone), slug);
        await redis.sadd(perPropLeadIdx(slug), phone);
      }
    }
    res.json({ ok: true, slug: prop.slug, stored: true });
  } catch (err) {
    console.error("❌ /init/facts error:", err);
    await incCounter("errors_ingest");
    res.status(500).json({ ok: false });
  }
});

// Health
app.get("/health", async (_req, res) => {
  try {
    const pong = await redis.ping();
    res.json({ ok: true, redis: pong === "PONG", time: nowIso(), env: NODE_ENV });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ---------- DEBUG ROUTES ----------

// Quick peek at a lead’s conversation
app.get("/debug/lead", async (req, res) => {
  try {
    const phone = normalizePhone(req.query.phone || "");
    if (!phone) return res.status(400).json({ ok: false, error: "Provide ?phone=+1..." });

    const [history, summary, intent, props] = await Promise.all([
      getLeadHistory(phone),
      getLeadSummary(phone),
      redis.get(leadIntentKey(phone)),
      redis.smembers(leadPropsKey(phone))
    ]);

    res.json({ ok: true, phone, intent, summary, properties: props, history });
  } catch (err) {
    console.error("❌ /debug/lead error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Quick peek at a property
app.get("/debug/property/:slug", async (req, res) => {
  try {
    const prop = await getPropertyContext(req.params.slug);
    if (!prop) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, prop });
  } catch (err) {
    console.error("❌ /debug/property error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ---------- START ----------
app.listen(PORT, () => {
  log.info(`🚀 AI Leasing Assistant v2 running on :${PORT} (${NODE_ENV})`);
});
