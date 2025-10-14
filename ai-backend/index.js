/**
 * AI Voice Rental — V3 + Handoff + Live Events (SSE)
 * --------------------------------------------------------------------
 * - Keeps original V1 ingestion (Zapier + BrowseAI) exactly as-is
 * - Auto-link on first SMS: lead ↔ property (from address/URL in text)
 * - Smarter AI reasoning + intent detection
 * - NEW: message history, AI→human handoff, dashboard /send/sms
 * - NEW: SSE stream for live dashboard updates
 */

import express from "express";
import bodyParser from "body-parser";
import Redis from "ioredis";
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
  TWILIO_FROM_NUMBER: ENV_TWILIO_FROM_NUMBER,
  HANDOFF_ENABLED: ENV_HANDOFF_ENABLED,
  // For CORS on SSE (set to your dashboard URL, e.g., https://ai-leasing-dashboard.onrender.com)
  DASHBOARD_ORIGIN = "*",
} = process.env;

const TWILIO_FROM_NUMBER = ENV_TWILIO_FROM_NUMBER || TWILIO_PHONE_NUMBER;
const HANDOFF_ENABLED = String(ENV_HANDOFF_ENABLED ?? "true") === "true";

// ---------- GUARDS ----------
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

// Tiny request log
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// CORS (for dashboard connecting to SSE from the browser)
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

async function incCounter(field) {
  try {
    await redis.hincrby(ANALYTICS_KEY, field, 1);
  } catch (_e) {}
}

const normalizePhone = (num) => {
  if (!num) return "";
  let s = String(num).trim();
  if (!s.startsWith("+")) s = "+1" + s.replace(/[^\d]/g, "");
  return s;
};

const slugify = (s) =>
  (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)+/g, "");

const nowIso = () => new Date().toISOString();

const propertyKey = (slug) => `property:${slug}`;
const leadPropsKey = (phone) => `lead:${phone}:properties`;
const perPropLeadIdx = (slug) => `property:${slug}:leads`;

// Conversation state keys (AI vs Human handoff)
const convModeKey = (phone) => `conv:${phone}:mode`; // "auto" | "human"
const convHandoffReasonKey = (phone) => `conv:${phone}:handoff_reason`;
const convHandoffAtKey = (phone) => `conv:${phone}:handoff_at`;
const convOwnerKey = (phone) => `conv:${phone}:owner`;
const handoffQueueKey = "queue:handoffs";
const leadHistoryKey = (phone) => `lead:${phone}:history`; // list of {t, role, content, meta?}

async function appendHistory(phone, role, content, meta) {
  const item = { t: nowIso(), role, content };
  if (meta && typeof meta === "object") item.meta = meta;
  try {
    await redis.rpush(leadHistoryKey(phone), JSON.stringify(item));
    // Publish a live event for the dashboard via Pub/Sub
    await redis.publish(`events:lead:${phone}`, JSON.stringify({ type: "message", item }));
    // Optional cap:
    // await redis.ltrim(leadHistoryKey(phone), -200, -1);
  } catch (e) {
    console.error("history append error:", e);
  }
}

async function setPropertyV1Merge(obj) {
  // V1 behavior: merge whatever arrives (no schema enforcement)
  if (!obj) obj = {};
  let slug = slugify(obj.slug || obj.address || "");
  // Prefer clean slug from origin URL if available (does NOT alter summary)
  const origin = obj.origin_url || obj["Origin URL"] || obj.source_url;
  if (origin && (!slug || slug.length < 6 || slug.length > 80)) {
    try {
      const parts = String(origin).split("/");
      const last = parts[parts.length - 1] || "";
      const fromUrl = slugify(last);
      if (fromUrl) slug = fromUrl;
    } catch {}
  }
  if (!slug) throw new Error("Property slug/address required");

  const key = propertyKey(slug);
  const existingRaw = await redis.get(key);
  const existing = existingRaw ? JSON.parse(existingRaw) : {};

  const merged = {
    ...existing,
    ...obj, // keep ALL raw fields
    slug,
    last_updated: nowIso(),
  };
  await redis.set(key, JSON.stringify(merged), "EX", 6 * 3600);
  return merged;
}

async function getProperty(slug) {
  const raw = await redis.get(propertyKey(slug));
  return raw ? JSON.parse(raw) : null;
}

async function findBestPropertyForLead(phone) {
  const slugs = await redis.smembers(leadPropsKey(phone));
  if (slugs.length) {
    let newest = null;
    for (const s of slugs) {
      const p = await getProperty(s);
      if (p && (!newest || p.last_updated > newest.last_updated)) newest = p;
    }
    return newest;
  }
  return null;
}

// Extract a property slug from an inbound text (address or URL in the text)
function extractSlugFromText(text) {
  if (!text) return "";

  // Prefer URL if present
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) {
    try {
      const u = urlMatch[0];
      const parts = u.split("/");
      const last = parts[parts.length - 1] || "";
      const slug = slugify(last);
      if (slug) return slug;
    } catch {}
  }

  // Fallback: naïve address → slug
  const addrMatch = text.match(
    /\b\d{2,6}\s+[a-z0-9 ]+(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|trail|terrace|ter|place|pl|court|ct)\b.*?(?:calgary|edmonton|ab|alberta)?/i
  );
  if (addrMatch) {
    const slug = slugify(addrMatch[0]);
    if (slug) return slug;
  }

  return "";
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
  "spam_or_unknown",
];

async function detectIntent(text) {
  try {
    const sys = `Classify the user's SMS into one of these labels: ${INTENT_LABELS.join(
      ", "
    )}. Return ONLY the label (no punctuation).`;
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
  } catch (e) {
    console.error("❌ Intent detect error:", e);
    return "general_info";
  }
}

// ---------- AI REASONING ----------
function buildContextFromProperty(property) {
  if (!property) return "";

  const candidates = [
    "address",
    "unit_type",
    "rent",
    "available",
    "parking",
    "pets",
    "utilities",
    "deposit",
    "Title Summary",
    "Available Floor Plan Options",
    "Property Details",
    "Parking Information",
    "Utility Information",
    "Summary",
    "source_url",
    "Origin URL",
  ];

  const lines = [];
  for (const key of candidates) {
    if (property[key]) {
      let val = String(property[key]).replace(/\s+\n/g, "\n").trim();
      if (val.length > 600) val = val.slice(0, 600) + "…";
      lines.push(`- ${key}: ${val}`);
    }
  }

  if (lines.length < 4) {
    try {
      let snap = JSON.stringify(property);
      if (snap.length > 1200) snap = snap.slice(0, 1200) + "…";
      lines.push(`- snapshot: ${snap}`);
    } catch {}
  }

  return `Property Info:\n${lines.join("\n")}`;
}

async function aiReply({ incomingText, property, intent }) {
  const context = buildContextFromProperty(property);
  const system = `
You are a warm, human-sounding leasing assistant for a property management company.
Never say you're an AI. Be concise (1–2 sentences) and proactive. Use any property facts given verbatim.`;

  const messages = [
    { role: "system", content: system },
    {
      role: "user",
      content: `${context}\n\nLead intent: ${intent}\nLead message: ${incomingText}`,
    },
  ];

  try {
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.4,
      messages,
    });
    return (
      resp.choices?.[0]?.message?.content?.trim() ||
      "Thanks for reaching out!"
    );
  } catch (e) {
    console.error("❌ OpenAI reply error:", e);
    return "Hey! Thanks for reaching out — when would you like to see the place?";
  }
}

// ---------- HANDOFF LOGIC ----------
const HANDOFF_REASONS = {
  LOW_CONF: "LOW_CONF",
  POLICY_UNKNOWN: "POLICY_UNKNOWN",
  OOS_INTENT: "OOS_INTENT",
  MAX_TURNS: "MAX_TURNS",
};

async function shouldHandoff({ phone, text, intent, property }) {
  if (!HANDOFF_ENABLED) return null;

  // Out-of-scope examples
  if (/\b(transfer|terminate|legal|complaint|lawyer)\b/i.test(text)) {
    return HANDOFF_REASONS.OOS_INTENT;
  }

  // Policy gaps: renter is asking policy but we lack facts
  const policyIntents = [
    "pricing_question",
    "availability",
    "parking",
    "pets",
    "application_process",
  ];
  if (policyIntents.includes(intent) && !property) {
    return HANDOFF_REASONS.POLICY_UNKNOWN;
  }

  // Max turns without resolution (~6 exchanges)
  const turns = await redis.llen(leadHistoryKey(phone));
  if (turns > 12) return HANDOFF_REASONS.MAX_TURNS;

  return null;
}

async function handoffToHuman(phone, reason) {
  const now = nowIso();
  await redis.mset(
    convModeKey(phone), "human",
    convHandoffReasonKey(phone), reason,
    convHandoffAtKey(phone), now
  );
  await redis.lpush(handoffQueueKey, phone);
  // Publish mode change
  await redis.publish(`events:lead:${phone}`, JSON.stringify({
    type: "mode",
    mode: "human",
    handoffReason: reason
  }));
}

async function aiPermitted(phone) {
  const mode = await redis.get(convModeKey(phone));
  return mode !== "human"; // default allow if unset
}

// ---------- TWILIO SEND ----------
async function sendSms(to, body) {
  const msg = { to, body };
  if (TWILIO_MESSAGING_SERVICE_SID) msg.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
  else msg.from = TWILIO_FROM_NUMBER;
  return twilioClient.messages.create(msg);
}

// ---------- ROUTES ----------

// Twilio inbound SMS (V1 plumbing + brain + auto-link + handoff)
app.post("/twilio/sms", async (req, res) => {
  try {
    const from = normalizePhone(req.body.From);
    const body = (req.body.Body || "").trim();
    console.log("📩 Inbound SMS:", from, body);
    if (!from || !body) return res.status(200).send("");

    await incCounter("inbound_sms");
    await appendHistory(from, "user", body);

    // Auto-link lead -> property
    const possibleSlug = extractSlugFromText(body);
    if (possibleSlug) {
      await redis.sadd(leadPropsKey(from), possibleSlug);
      await redis.sadd(perPropLeadIdx(possibleSlug), from);
      console.log(`🏷️ Linked lead ${from} → property ${possibleSlug} (from SMS text)`);
    }

    // Resolve property
    let property = await findBestPropertyForLead(from);
    if (!property) {
      const keys = (await redis.keys("property:*")).filter(
        (k) => !k.endsWith(":leads")
      );
      if (keys.length) {
        const recent = keys.sort().reverse()[0];
        const raw = await redis.get(recent);
        try { property = JSON.parse(raw); } catch {}
      }
    }
    console.log("🏠 Property resolved:", property ? property.slug : "none");

    // Human mode → AI muted
    if (!(await aiPermitted(from))) {
      console.log("🤫 AI muted (human mode).");
      return res.status(200).send("");
    }

    // Intent + possible handoff
    const intent = await detectIntent(body);
    console.log("🎯 Detected intent:", intent);

    const reason = await shouldHandoff({ phone: from, text: body, intent, property });
    if (reason) {
      console.log("🧭 Handoff triggered:", reason);
      await handoffToHuman(from, reason);
      const msg = "Thanks! I’m looping in a leasing specialist to help with that.";
      await appendHistory(from, "assistant", msg, { handoff: reason });
      await sendSms(from, msg);
      await incCounter("replied_sms");
      return res.status(200).send("");
    }

    // AI reply (booking-first)
    const reply = await aiReply({ incomingText: body, property, intent });
    console.log("💬 AI reply generated:", reply);
    await appendHistory(from, "assistant", reply);
    await sendSms(from, reply);
    await incCounter("replied_sms");
    console.log("✅ SMS sent to lead:", from);

    res.status(200).send("");
  } catch (err) {
    console.error("❌ SMS webhook error:", err);
    await incCounter("errors_sms");
    res.status(200).send("");
  }
});

// Dashboard → send human reply (also flips to human mode)
app.post("/send/sms", async (req, res) => {
  try {
    const { to, text, agentId } = req.body || {};
    const phone = normalizePhone(to);
    if (!phone || !text)
      return res.status(400).json({ ok: false, error: "Missing to/text" });

    await appendHistory(phone, "agent", text, { agentId: agentId || "agent" });
    await redis.mset(
      convModeKey(phone), "human",
      convOwnerKey(phone), agentId || "agent"
    );
    try { await redis.lrem(handoffQueueKey, 0, phone); } catch {}

    // Publish mode change (explicit)
    await redis.publish(`events:lead:${phone}`, JSON.stringify({
      type: "mode",
      mode: "human",
      owner: agentId || "agent"
    }));

    const msg = { to: phone, body: text };
    if (TWILIO_MESSAGING_SERVICE_SID) msg.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
    else msg.from = TWILIO_FROM_NUMBER;

    await twilioClient.messages.create(msg);

    res.json({ ok: true });
  } catch (e) {
    console.error("send/sms error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Zapier → property stub (V1 style: just stash what arrives)
app.post("/init/facts", async (req, res) => {
  try {
    const { leadPhone, property, unit, finalUrl } = req.body || {};
    const obj = {
      address: property,
      unit_type: unit,
      source_url: finalUrl,
      lead_phone: leadPhone,
    };
    const prop = await setPropertyV1Merge(obj);

    if (leadPhone) {
      const phone = normalizePhone(leadPhone);
      await redis.sadd(leadPropsKey(phone), prop.slug);
      await redis.sadd(perPropLeadIdx(prop.slug), phone);
    }

    console.log("🧾 /init/facts stored:", prop.slug);
    res.json({ ok: true, slug: prop.slug, stored: true });
  } catch (err) {
    console.error("❌ /init/facts error:", err);
    res.status(500).json({ ok: false });
  }
});

// BrowseAI webhook — V1 ORIGINAL merge-anything
app.post("/browseai/webhook", async (req, res) => {
  try {
    const body = req.body || {};
    const task = body.task || {};
    const texts = task.capturedTexts || {};
    const input = task.inputParameters || {};

    const data = {
      ...body,
      ...task,
      ...texts,
      origin_url: input.originUrl || body.origin_url || "",
    };

    let slug = "";
    if (data.origin_url) {
      try {
        const parts = String(data.origin_url).split("/");
        const last = parts[parts.length - 1] || "";
        slug = slugify(last);
      } catch {}
    }
    if (!slug) {
      slug = slugify(
        data.slug ||
          data.address ||
          data.Summary ||
          data["Property Details"] ||
          data["Title Summary"] ||
          ""
      );
    }
    if (!slug) {
      console.warn("⚠️ BrowseAI webhook missing slug/address field:", body);
      return res.status(200).json({ ok: false, error: "Missing property slug/address" });
    }

    const merged = await setPropertyV1Merge({ ...data, slug });

    const leadPhone = normalizePhone(
      data.lead_phone || body.leadPhone || task.lead_phone || ""
    );
    if (leadPhone) {
      await redis.sadd(leadPropsKey(leadPhone), slug);
      await redis.sadd(perPropLeadIdx(slug), leadPhone);
    }

    await incCounter("property_ingest");

    console.log(`🏗️ [V1-style] Stored property: ${slug}`);
    console.log(`📦 Fields received: ${Object.keys(data).length}`);
    res.json({ ok: true, slug, stored: true });
  } catch (err) {
    console.error("❌ BrowseAI ingest error:", err);
    await incCounter("errors_ingest");
    res.status(500).json({ ok: false });
  }
});

// ---------- SSE: Live events for a conversation ----------
app.get("/events/conversation/:phone", async (req, res) => {
  const phone = normalizePhone(req.params.phone || "");
  if (!phone) return res.status(400).end("Missing phone");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", DASHBOARD_ORIGIN);
  res.flushHeaders?.();

  // Heartbeat to keep connections alive through proxies
  const heartbeat = setInterval(() => {
    res.write("event: ping\n");
    res.write("data: {}\n\n");
  }, 25000);

  // Initial snapshot
  try {
    const [mode, reason, owner] = await redis.mget(
      convModeKey(phone),
      convHandoffReasonKey(phone),
      convOwnerKey(phone)
    );
    const snapshot = {
      type: "snapshot",
      mode: mode || "auto",
      handoffReason: reason || "",
      owner: owner || ""
    };
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  } catch (_) {}

  // Subscribe to Pub/Sub for this lead
  const sub = new Redis(REDIS_URL);
  const channel = `events:lead:${phone}`;
  await sub.subscribe(channel);

  sub.on("message", (_ch, msg) => {
    res.write(`data: ${msg}\n\n`);
  });

  req.on("close", () => {
    clearInterval(heartbeat);
    try { sub.disconnect(); } catch {}
  });
});

// ---------- DEBUG + HEALTH ----------
app.get("/debug/lead", async (req, res) => {
  const phone = normalizePhone(req.query.phone || "");
  if (!phone) return res.status(400).json({ ok: false, error: "Provide ?phone=+1..." });
  const props = await redis.smembers(leadPropsKey(phone));
  res.json({ ok: true, phone, properties: props });
});

app.get("/debug/property/:slug", async (req, res) => {
  const prop = await getProperty(req.params.slug);
  if (!prop) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true, prop });
});

app.get("/health", async (_req, res) => {
  try {
    const pong = await redis.ping();
    res.json({ ok: true, redis: pong === "PONG", time: nowIso(), env: NODE_ENV });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`🚀 V3+Handoff+SSE on :${PORT} (${NODE_ENV})`);
});
