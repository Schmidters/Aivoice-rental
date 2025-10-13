/**
 * AI Voice Rental — V3 (V1 plumbing + V2 brain, zero ingestion changes)
 * --------------------------------------------------------------------
 * - Keeps original V1 ingestion (Zapier + BrowseAI) exactly as-is
 * - BrowseAI webhook: merge-anything V1 style (no schema enforcement)
 * - Adds auto-link on first SMS: lead ↔ property (from address/URL in text)
 * - Smarter AI reasoning + intent detection (no changes to your data flow)
 * - Debug logs for precise visibility in Render
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
app.use(bodyParser.urlencoded({ extended: true })); // Twilio posts form-encoded
app.use(bodyParser.json());

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
    ...obj, // keep ALL raw BrowseAI/Zapier fields (Summary, Property Details, etc.)
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
// This links lead → property immediately (V1 feeling, explicit link)
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

  // Fallback: naïve address → slug (e.g., "215 16 Street Southeast")
  const addrMatch = text.match(
    /\b\d{2,6}\s+[a-z0-9 ]+(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|trail|terrace|ter|place|pl|court|ct)\b.*?(?:calgary|edmonton|ab|alberta)?/i
  );
  if (addrMatch) {
    const slug = slugify(addrMatch[0]);
    if (slug) return slug;
  }

  return "";
}

// ---------- INTENT DETECTION (brain layer only; does not change data model) ----------
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

// ---------- AI REASONING (reads whatever data exists; no schema assumption) ----------
function buildContextFromProperty(property) {
  if (!property) return "";

  // Try to surface the most useful fields if present,
  // but keep V1 robustness by falling back to a trimmed JSON dump.
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

  // If still thin, include a compact JSON snapshot (keeps V1 behavior)
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
    return resp.choices?.[0]?.message?.content?.trim() ||
      "Thanks for reaching out!";
  } catch (e) {
    console.error("❌ OpenAI reply error:", e);
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

// Twilio inbound SMS (V1 plumbing + new brain + auto-link)
app.post("/twilio/sms", async (req, res) => {
  try {
    const from = normalizePhone(req.body.From);
    const body = (req.body.Body || "").trim();
    console.log("📩 Inbound SMS:", from, body);
    if (!from || !body) return res.status(200).send("");

    await incCounter("inbound_sms");

    // NEW: immediately try to link lead → property from the text itself
    const possibleSlug = extractSlugFromText(body);
    if (possibleSlug) {
      await redis.sadd(leadPropsKey(from), possibleSlug);
      await redis.sadd(perPropLeadIdx(possibleSlug), from);
      console.log(`🏷️ Linked lead ${from} → property ${possibleSlug} (from SMS text)`);
    }

    // Resolve property (V1 behavior)
    let property = await findBestPropertyForLead(from);

    // Fallback: latest property key (ignoring :leads sets)
    if (!property) {
      const keys = (await redis.keys("property:*")).filter(
        (k) => !k.endsWith(":leads")
      );
      if (keys.length) {
        const recent = keys.sort().reverse()[0];
        const raw = await redis.get(recent);
        try {
          property = JSON.parse(raw);
        } catch {}
      }
    }

    console.log("🏠 Property resolved:", property ? property.slug : "none");

    // Brain: intent + reply
    const intent = await detectIntent(body);
    console.log("🎯 Detected intent:", intent);

    const reply = await aiReply({ incomingText: body, property, intent });
    console.log("💬 AI reply generated:", reply);

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

// BrowseAI webhook — V1 ORIGINAL merge-anything (no schema enforcement)
app.post("/browseai/webhook", async (req, res) => {
  try {
    const body = req.body || {};
    const task = body.task || {};
    const texts = task.capturedTexts || {};
    const input = task.inputParameters || {};

    // Merge everything (V1 behavior)
    const data = {
      ...body,
      ...task,
      ...texts,
      origin_url: input.originUrl || body.origin_url || "",
    };

    // Derive slug (prefer origin_url for cleanliness, but DO NOT touch Summary/data)
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

    // Link if any phone known inside payload
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
  console.log(`🚀 V3 running on :${PORT} (${NODE_ENV}) — V1 plumbing intact, smarter brain on top`);
});
