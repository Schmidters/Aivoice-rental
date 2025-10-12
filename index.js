/**
 * AI Voice Rental — v2 “AI Brain Expansion”
 * - Property Context Enrichment (Redis cache)
 * - Lead Memory (per-lead history + auto-summarization)
 * - Intent Detection (classifier)
 * - Unified Prompt (human leasing assistant)
 * - Lightweight analytics counters
 *
 * Assumes a working v1 (Express + Twilio + Redis + OpenAI).
 * This file is self-contained; wire it to your existing Render app.
 */

require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const Redis = require("ioredis");
const { v4: uuidv4 } = require("uuid");
const pino = require("pino");
const OpenAI = require("openai");

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_MESSAGING_SERVICE_SID,
  TWILIO_PHONE_NUMBER,
  TWILIO_FROM_NUMBER: ENV_TWILIO_FROM_NUMBER, // optional alias
} = process.env;

// Backward-compatible variable (uses either one)
const TWILIO_FROM_NUMBER = ENV_TWILIO_FROM_NUMBER || TWILIO_PHONE_NUMBER;

// ---------- ENV ----------
const {
  PORT = 3000,
  NODE_ENV = "production",
  REDIS_URL,
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",
  OPENAI_MODEL_SUMMARY = "gpt-4o-mini",
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_MESSAGING_SERVICE_SID, // or TWILIO_FROM_NUMBER
  TWILIO_FROM_NUMBER,
} = process.env;

// ---------- GUARDS ----------
if (!REDIS_URL) throw new Error("Missing REDIS_URL");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  throw new Error("Missing Twilio credentials (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)");
}
if (!TWILIO_MESSAGING_SERVICE_SID && !TWILIO_FROM_NUMBER) {
  throw new Error("Provide TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER");
}

// ---------- CORE ----------
const app = express();
app.use(bodyParser.urlencoded({ extended: false })); // Twilio sends x-www-form-urlencoded
app.use(bodyParser.json());

const log = pino({ level: NODE_ENV === "development" ? "debug" : "info" });
const redis = new Redis(REDIS_URL, { lazyConnect: false });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ---------- CONSTANTS ----------
const MAX_HISTORY_ITEMS = 12;     // keep most recent messages for context
const SUMMARY_AFTER = 10;         // summarize history after this many turns
const MAX_HISTORY_TOKEN_HINT = 800; // (heuristic) used in summarization
const PROPERTY_TTL_SECONDS = 6 * 60 * 60; // 6 hours (refreshable by scrape ingest)
const ANALYTICS_KEY = "analytics:counters"; // Redis hash
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

// ---------- HELPERS ----------
const normalizePhone = (num) => {
  if (!num) return "";
  let s = num.trim();
  if (!s.startsWith("+")) {
    // Normalize to E.164-ish if possible; assume North America if missing
    s = "+1" + s.replace(/[^\d]/g, "");
  }
  return s;
};

const slugify = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");

const propertyKey = (slug) => `property:${slug}`;
const leadHistoryKey = (phone) => `lead:${phone}:history`;
const leadSummaryKey = (phone) => `lead:${phone}:summary`;
const leadIntentKey = (phone) => `lead:${phone}:intent`;
const leadPropsKey = (phone) => `lead:${phone}:properties`; // set of slugs
const perPropLeadIdx = (slug) => `property:${slug}:leads`; // set of phones

async function incCounter(field) {
  await redis.hincrby(ANALYTICS_KEY, field, 1);
}

function nowIso() {
  return new Date().toISOString();
}

function trimText(str, max = 300) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "…" : str;
}

// ---------- MEMORY LAYER ----------
async function appendLeadHistory(phone, role, content) {
  const key = leadHistoryKey(phone);
  const item = JSON.stringify({ t: nowIso(), role, content: trimText(content, 1000) });
  await redis.lpush(key, item);
  await redis.ltrim(key, 0, MAX_HISTORY_ITEMS - 1);
}

async function getLeadHistory(phone) {
  const raw = await redis.lrange(leadHistoryKey(phone), 0, -1);
  return raw.map((s) => {
    try { return JSON.parse(s); } catch { return null; }
  }).filter(Boolean).reverse(); // oldest → newest
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

  // Build a compact transcript to summarize
  const transcript = history
    .map(h => `[${h.t}] ${h.role === "user" ? "Lead" : "Assistant"}: ${h.content}`)
    .join("\n");

  const prompt = `Summarize the following SMS conversation between a leasing assistant and a rental lead. 
Keep it under ${Math.round(MAX_HISTORY_TOKEN_HINT)} tokens. 
Capture key facts mentioned (timing preferences, desired unit type, budget, questions asked, objections).
Conversation:
${transcript}`;

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL_SUMMARY,
    temperature: 0.2,
    messages: [
      { role: "system", content: "You create concise, factual CRM-style conversation summaries." },
      { role: "user", content: prompt }
    ]
  });

  const summary = resp.choices?.[0]?.message?.content?.trim() || "";
  if (summary) await setLeadSummary(phone, summary);
}

// ---------- PROPERTY CONTEXT ----------
/**
 * Example property object structure we store:
 * {
 *   slug: "215-16-street-southeast",
 *   address: "215 16 Street Southeast, Calgary",
 *   unit_type: "1-Bedroom",
 *   rent: 1895,
 *   bedrooms: 1,
 *   bathrooms: 1,
 *   sqft: 620,
 *   parking: "Included", // or "Available $150", "Street", "None"
 *   pets: "Small pets OK", // or "No pets"
 *   utilities: "Heat & Water Included",
 *   available: "Nov 1",
 *   deposit: "One month",
 *   application_url: "https://…",
 *   photos_url: "https://…",
 *   source_url: "https://…",
 *   last_updated: "2025-10-12T18:00:00Z"
 * }
 */
async function setPropertyContext(obj) {
  const slug = slugify(obj.slug || obj.address);
  if (!slug) throw new Error("Property slug/address required");

  const key = propertyKey(slug);
  const data = {
    slug,
    last_updated: nowIso(),
    ...obj
  };
  await redis.set(key, JSON.stringify(data), "EX", PROPERTY_TTL_SECONDS);
  return data;
}

async function getPropertyContext(slug) {
  const raw = await redis.get(propertyKey(slug));
  return raw ? JSON.parse(raw) : null;
}

async function findBestPropertyForLead(phone) {
  // First check if lead already touched any property
  const props = await redis.smembers(leadPropsKey(phone));
  if (props && props.length) {
    // Prefer the most recently updated among them
    let newest = null;
    for (const s of props) {
      const p = await getPropertyContext(s);
      if (p && (!newest || (p.last_updated > newest.last_updated))) newest = p;
    }
    if (newest) return newest;
  }
  // Fallback: none
  return null;
}

// ---------- INTENT DETECTION ----------
async function detectIntent(messageText) {
  const sys = `Classify the user's SMS into one of these labels: ${INTENT_LABELS.join(", ")}.
Return ONLY the label. If unclear or spam, use "spam_or_unknown".`;

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: messageText || "" }
    ]
  });

  const label = resp.choices?.[0]?.message?.content?.trim();
  return INTENT_LABELS.includes(label) ? label : "spam_or_unknown";
}

// ---------- UNIFIED AGENT PROMPT ----------
function buildAgentSystemPrompt(property, summary) {
  const facts = property ? `
Property Info:
- Address: ${property.address || property.slug}
- Unit: ${property.unit_type || "N/A"}
- Rent: ${property.rent ? `$${property.rent}` : "N/A"}
- Bedrooms/Bath: ${property.bedrooms ?? "?"}/${property.bathrooms ?? "?"}
- Sqft: ${property.sqft ?? "?"}
- Parking: ${property.parking ?? "N/A"}
- Pets: ${property.pets ?? "N/A"}
- Utilities: ${property.utilities ?? "N/A"}
- Available: ${property.available ?? "N/A"}
- Apply: ${property.application_url ?? "Ask me and I’ll send it"}
` : `
Property Info:
- (No cached details available yet. If asked, request to share the listing link or give general guidance.)`;

  const mem = summary ? `Lead Summary (from prior messages): ${summary}\n` : "";

  return `
You are a friendly, human-sounding leasing assistant for a property management company.
Never say you are an AI. Keep replies warm, concise (1–2 sentences), and proactive.

${facts}
${mem}

Rules:
- Answer directly and factually using Property Info when relevant.
- If the lead asks to book a showing, propose 2 time options (e.g., tomorrow 6pm or Saturday 2pm) and offer to confirm.
- If asked about parking/pets/utilities, answer precisely from Property Info.
- If price sensitive or negotiating, be empathetic and offer alternatives without committing to discounts.
- If spam/off-topic, reply once politely or ignore.
- Always write like a real human text — no corporate tone, no disclaimers.
`;
}

// ---------- REPLY GENERATION ----------
async function generateAssistantReply({ incomingText, property, history, summary }) {
  const system = buildAgentSystemPrompt(property, summary);

  const msgs = [
    { role: "system", content: system }
  ];

  // Inject brief recent conversation for continuity
  for (const h of (history || []).slice(-6)) {
    msgs.push({ role: h.role === "assistant" ? "assistant" : "user", content: h.content });
  }
  msgs.push({ role: "user", content: incomingText });

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.4,
    messages: msgs
  });

  return resp.choices?.[0]?.message?.content?.trim() || "Thanks for reaching out! How can I help?";
}

// ---------- TWILIO SEND ----------
async function sendSms(to, body) {
  const msg = {
    to,
    body
  };
  if (TWILIO_MESSAGING_SERVICE_SID) {
    msg.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
  } else {
    msg.from = TWILIO_FROM_NUMBER;
  }
  const res = await twilioClient.messages.create(msg);
  return res.sid;
}

// ---------- WEBHOOKS ----------

/**
 * Twilio SMS Inbound Webhook
 * Fields of interest: From, To, Body
 * Optional: a property hint can be passed via your ad links as metadata in previous flow.
 */
app.post("/twilio/sms", async (req, res) => {
  try {
    const from = normalizePhone(req.body.From);
    const to = normalizePhone(req.body.To);
    const body = (req.body.Body || "").trim();

    if (!from || !body) {
      res.status(200).send(""); // ack fast
      return;
    }

    // Analytics
    await incCounter("inbound_sms");

    // Append inbound to memory
    await appendLeadHistory(from, "user", body);

    // Try to resolve a property context for this lead
    let property = await findBestPropertyForLead(from);
    const summary = await getLeadSummary(from);
    const history = await getLeadHistory(from);

    // Intent detection (lightweight)
    const intent = await detectIntent(body);
    await redis.set(leadIntentKey(from), intent, "EX", 2 * 24 * 3600);

    // Dynamic behaviors (examples)
    if (intent === "spam_or_unknown") {
      // Optional: silently ignore or send one polite reply
      const reply = "Hey there — are you asking about one of our rentals? Happy to help with availability, price, or showings.";
      await sendSms(from, reply);
      await appendLeadHistory(from, "assistant", reply);
      await incCounter("replied_sms");
      res.status(200).send("");
      return;
    }

    if (intent === "availability" && property && property.available) {
      const reply = `Yes — it's available. Want to see it ${property.available === "Now" ? "today or tomorrow" : `around ${property.available}`}? I can offer tomorrow 6pm or Saturday 2pm.`;
      await sendSms(from, reply);
      await appendLeadHistory(from, "assistant", reply);
      await maybeSummarizeHistory(from);
      await incCounter("replied_sms");
      res.status(200).send("");
      return;
    }

    // General reply using unified prompt + history + property facts
    const reply = await generateAssistantReply({
      incomingText: body,
      property,
      history,
      summary
    });

    await sendSms(from, reply);
    await appendLeadHistory(from, "assistant", reply);
    await maybeSummarizeHistory(from);
    await incCounter("replied_sms");

    res.status(200).send(""); // Twilio requires quick 2xx
  } catch (err) {
    log.error({ err }, "SMS webhook error");
    await incCounter("errors_sms");
    // Twilio still needs a 2xx; we won't retry here
    res.status(200).send("");
  }
});

/**
 * BrowseAI (or any scraper) → Property Ingest Webhook
 * POST JSON payload like:
 * {
 *   "address": "215 16 Street Southeast, Calgary",
 *   "slug": "215-16-street-southeast",
 *   "unit_type": "1-Bedroom",
 *   "rent": 1895,
 *   "bedrooms": 1,
 *   "bathrooms": 1,
 *   "sqft": 620,
 *   "parking": "Included",
 *   "pets": "Small pets OK",
 *   "utilities": "Heat & Water Included",
 *   "available": "Nov 1",
 *   "application_url": "https://...",
 *   "photos_url": "https://...",
 *   "source_url": "https://..."
 * }
 * Optionally pass lead_phone to bind a lead → property.
 */
app.post("/browseai/webhook", async (req, res) => {
  try {
    const payload = req.body || {};
    const slug = slugify(payload.slug || payload.address);
    if (!slug) return res.status(400).json({ ok: false, error: "Missing property slug/address" });

    const prop = await setPropertyContext({ ...payload, slug });
    await incCounter("property_ingest");

    // If lead phone provided, link it
    if (payload.lead_phone) {
      const phone = normalizePhone(payload.lead_phone);
      if (phone) {
        await redis.sadd(leadPropsKey(phone), slug);
        await redis.sadd(perPropLeadIdx(slug), phone);
      }
    }

    res.json({ ok: true, slug: prop.slug, stored: true });
  } catch (err) {
    log.error({ err }, "Property ingest error");
    await incCounter("errors_ingest");
    res.status(500).json({ ok: false });
  }
});

// ---------- LIGHT UTILITIES / INSIGHTS ----------
app.get("/health", async (_req, res) => {
  try {
    const pong = await redis.ping();
    res.json({ ok: true, redis: pong === "PONG", time: nowIso(), env: NODE_ENV });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// simple JSON view for a lead’s recent history + summary (for debugging)
app.get("/debug/lead", async (req, res) => {
  const phone = normalizePhone(req.query.phone || "");
  if (!phone) return res.status(400).json({ ok: false, error: "Provide ?phone=+1..." });
  const [history, summary, intent] = await Promise.all([
    getLeadHistory(phone),
    getLeadSummary(phone),
    redis.get(leadIntentKey(phone))
  ]);
  res.json({ ok: true, phone, intent, summary, history });
});

// quick peek at a property
app.get("/debug/property/:slug", async (req, res) => {
  const prop = await getPropertyContext(req.params.slug);
  if (!prop) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true, prop });
});

// ---------- START ----------
app.listen(PORT, () => {
  log.info(`🚀 AI Leasing Assistant v2 running on :${PORT} (${NODE_ENV})`);
});
