// --- Imports & setup ---
import "dotenv/config.js";
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { DateTime } from "luxon";
import twilio from "twilio";
import Redis from "ioredis";
import OpenAI from "openai";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import fetch from "node-fetch";

// --- App setup ---
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// --- Config ---
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://aivoice-rental.onrender.com";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const REDIS_URL = process.env.REDIS_URL;

const DEBUG_SECRET = process.env.DEBUG_SECRET || "changeme123";
const DEBUG_LEVEL = (process.env.DEBUG_LEVEL || "info").toLowerCase(); // "debug" | "info" | "warn" | "error"

const HTML_SNIPPET_LIMIT = parseInt(process.env.HTML_SNIPPET_LIMIT || "20000", 10); // 20k chars cap

// --- Clients ---
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const redis = new Redis(REDIS_URL, { tls: false });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- Logging helpers ---
const nowIso = () => new Date().toISOString();
function log(level, msg, meta = {}) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  if (levels[level] < levels[DEBUG_LEVEL]) return;
  console.log(JSON.stringify({ ts: nowIso(), level, msg, ...meta }));
}
function timeStart(label) { return { label, t0: Date.now() }; }
function timeEnd(t, extra = {}) {
  const ms = Date.now() - t.t0;
  log("debug", `⏱️ ${t.label}`, { ms, ...extra });
}

// --- Utilities ---
function normalizePhone(phone) {
  if (!phone) return null;
  const parsed = parsePhoneNumberFromString(phone, "CA");
  return parsed && parsed.isValid() ? parsed.number : phone;
}
function slugify(str) {
  return str ? str.replace(/\s+/g, "-").replace(/[^\w\-]/g, "").toLowerCase() : "unknown";
}

// A tiny guard to avoid persisting obvious trackers (we expect finalUrl already cleaned by Zapier)
function isTracker(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return [
      "ct.sendgrid.net",
      "cloudflare.com",
      "challenge.cloudflare.com",
      "bit.ly",
      "lnkd.in",
      "l.instagram.com",
      "linktr.ee",
    ].some(d => h.endsWith(d));
  } catch { return true; }
}

// --- Redis helpers ---
async function getConversation(phone, property) {
  const key = `conv:${phone}:${property}`;
  const data = await redis.get(key);
  return data ? JSON.parse(data) : [];
}
async function saveConversation(phone, property, messages) {
  const key = `conv:${phone}:${property}`;
  const metaKey = `meta:${phone}:${property}`;
  await redis.set(key, JSON.stringify(messages.slice(-10)));
  await redis.hset(metaKey, "lastInteraction", DateTime.now().toISO());
}
async function getPropertyFacts(phone, property) {
  const key = `facts:${phone}:${property}`;
  const data = await redis.get(key);
  return data ? JSON.parse(data) : {};
}
async function setPropertyFacts(phone, property, facts) {
  const key = `facts:${phone}:${property}`;
  await redis.set(key, JSON.stringify(facts));
  log("info", "💾 [Redis] Updated facts", { phone, property });
}

// --- Simple page fetcher (no headless browser) ---
const SIMPLE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-CA,en-US;q=0.9,en;q=0.8",
};
async function fetchListingHTML(url) {
  try {
    const resp = await fetch(url, { headers: SIMPLE_HEADERS, redirect: "follow" });
    if (!resp.ok) {
      log("warn", "⚠️ fetchListingHTML non-OK", { status: resp.status, url });
      return "";
    }
    const html = await resp.text();
    return html || "";
  } catch (err) {
    log("warn", "⚠️ fetchListingHTML error", { error: err.message, url });
    return "";
  }
}

// --- Reason from page HTML + known facts ---
async function aiReasonFromPage({ question, html, facts, url }) {
  try {
    const snippet = (html || "").slice(0, HTML_SNIPPET_LIMIT);
    const system = `
You are "Alex", a concise, friendly rental assistant.
You're given:
1) Known context (facts) for this lead.
2) The rental page HTML (truncated).
3) The user's question.

Use evidence from the HTML when possible. If something isn't explicitly stated, say "not mentioned" and/or explain uncertainty.
Keep replies under 3 sentences.`.trim();

    const messages = [
      { role: "system", content: system },
      { role: "user", content: `FACTS:\n${JSON.stringify(facts)}` },
      { role: "user", content: `RENTAL PAGE URL:\n${url || "unknown"}` },
      { role: "user", content: `RENTAL PAGE HTML (truncated):\n${snippet}` },
      { role: "user", content: `QUESTION:\n${question}` },
    ];

    const t = timeStart(`[ai] chat.completions`);
    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 250,
      temperature: 0.3,
    });
    timeEnd(t);
    const reply = ai.choices?.[0]?.message?.content?.trim();
    return reply || "Sorry—I couldn’t find that on the listing.";
  } catch (err) {
    log("error", "❌ aiReasonFromPage error", { error: err.message });
    return "Sorry—something went wrong reading the listing.";
  }
}

// --- Health check ---
app.get("/", (req, res) => res.send("✅ AI Rental Assistant is running"));

// --- Debug: get facts ---
app.get("/debug/facts", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  const { phone, property } = req.query;
  if (!phone) return res.status(400).send("Missing phone");
  const slug = property ? slugify(property) : "unknown";
  const facts = await getPropertyFacts(phone, slug);
  res.json({ phone, property: slug, facts });
});

// --- Debug: clear lead state ---
app.post("/debug/clear", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  const { phone, property } = req.body || {};
  if (!phone || !property) return res.status(400).json({ error: "Missing phone or property" });
  const slug = slugify(property);
  await redis.del(`conv:${phone}:${slug}`, `facts:${phone}:${slug}`, `meta:${phone}:${slug}`);
  res.json({ ok: true });
});

// --- Initialize property facts (from Zapier) ---
// Expect Zapier to send the *resolved* first-party URL as `finalUrl`.
app.post("/init/facts", async (req, res) => {
  try {
    let { phone, property, finalUrl, rent, unit } = req.body;
    if (!phone || !property) {
      return res.status(400).json({ error: "Missing phone or property" });
    }

    phone = normalizePhone(phone);
    const slug = slugify(property);

    if (finalUrl && isTracker(finalUrl)) {
      return res.status(422).json({
        error: "Tracking/interstitial URL provided. Resolve in Zapier first.",
        got: finalUrl,
      });
    }

    const facts = {
      phone,
      property: slug,
      address: property,
      rent: rent || null,
      unit: unit || null,
      listingUrl: finalUrl || null,
      initializedAt: nowIso(),
    };

    await setPropertyFacts(phone, slug, facts);
    log("info", "💾 [Init] Facts saved", { phone, property: slug, listingUrl: facts.listingUrl });

    // Return full JSON so you can test from Zapier
    return res.json({
      success: true,
      data: facts,
      smsEndpoint: `${PUBLIC_BASE_URL}/twiml/sms`,
    });
  } catch (err) {
    log("error", "❌ /init/facts error", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// --- Voice webhook (unchanged passthrough) ---
app.post("/twiml/voice", (req, res) => {
  const twiml = `
<Response>
  <Connect><Stream url="wss://aivoice-rental.onrender.com/twilio-media" /></Connect>
  <Say voice="Polly.Joanna">Hi, connecting you to the rental assistant now.</Say>
</Response>`.trim();
  res.type("text/xml").send(twiml);
});

// --- SMS webhook (Tier-1: direct fetch + LLM read) ---
app.post("/twiml/sms", async (req, res) => {
  const from = normalizePhone(req.body.From);
  const body = req.body.Body?.trim() || "";
  log("info", "📩 SMS received", { from, body });
  res.type("text/xml").send("<Response></Response>");

  try {
    // Try to guess a property slug from message; fallback to "unknown"
    const propertyRegex =
      /([0-9]{2,5}\s?[A-Za-z]+\s?(Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|SE|SW|NW|NE|Southeast|Southwest|Northeast|Northwest))/i;
    const match = body.match(propertyRegex);
    const propertySlug = slugify(match ? match[0] : "unknown");

    const prev = await getConversation(from, propertySlug);
    const facts = await getPropertyFacts(from, propertySlug);

    let reply = "Could you share the property link?";

    if (facts?.listingUrl && !isTracker(facts.listingUrl)) {
      const t = timeStart(`[fetch] listing HTML`);
      const html = await fetchListingHTML(facts.listingUrl);
      timeEnd(t, { ok: !!html, len: html?.length || 0 });

      if (html) {
        reply = await aiReasonFromPage({ question: body, html, facts, url: facts.listingUrl });
      } else {
        // fallback to facts-only (still keeps tone)
        const sys = {
          role: "system",
          content: `You are Alex, a friendly rental assistant. Known facts: ${JSON.stringify(facts)}.
If info isn't present, say "not mentioned". Keep replies under 3 sentences.`
        };
        const msgs = [sys, ...prev, { role: "user", content: body }];
        const ai = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: msgs,
          max_tokens: 180,
          temperature: 0.3,
        });
        reply = ai.choices?.[0]?.message?.content?.trim() || "I couldn't load the listing—could you resend the link?";
      }
    }

    log("info", "💬 GPT reply", { reply });
    const updated = [...prev, { role: "user", content: body }, { role: "assistant", content: reply }];
    await saveConversation(from, propertySlug, updated);
    await twilioClient.messages.create({ from: TWILIO_PHONE_NUMBER, to: from, body: reply });
    log("info", "✅ SMS sent", { to: from });
  } catch (err) {
    log("error", "❌ SMS error", { error: err.message });
  }
});

// --- Follow-up checker (unchanged) ---
app.get("/cron/followups", async (req, res) => {
  try {
    const keys = await redis.keys("meta:*");
    const now = DateTime.now().setZone("America/Edmonton");
    const followups = [];

    for (const key of keys) {
      const meta = await redis.hgetall(key);
      const last = meta.lastInteraction ? DateTime.fromISO(meta.lastInteraction) : null;
      if (!last) continue;
      const hoursSince = now.diff(last, "hours").hours;
      if (hoursSince > 24 && now.hour >= 9 && now.hour < 10) {
        const [, phone, property] = key.split(":");
        followups.push({ phone, property });
      }
    }

    for (const { phone, property } of followups) {
      const facts = await getPropertyFacts(phone, property);
      const text = facts?.address
        ? `Hey, just checking if you’d like to set up a showing for ${facts.address} 😊`
        : `Hey, just checking if you’re still interested in booking a showing 😊`;

      await twilioClient.messages.create({ from: TWILIO_PHONE_NUMBER, to: phone, body: text });
      log("info", "📆 Follow-up sent", { to: phone });
    }

    res.send(`✅ Follow-ups sent: ${followups.length}`);
  } catch (err) {
    log("error", "❌ Follow-up error", { error: err.message });
    res.status(500).send(err.message);
  }
});

// --- WebSocket for voice streaming (unchanged passthrough) ---
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio-media") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  else socket.destroy();
});
wss.on("connection", (ws) => {
  log("info", "🔊 Twilio media stream connected!");
  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === "start") log("info", "🎬 Stream started", { streamSid: data.streamSid });
      if (data.event === "stop") log("info", "🛑 Stream stopped", { streamSid: data.streamSid });
    } catch (err) {
      log("warn", "⚠️ WS parse error", { error: err.message });
    }
  });
});

// --- Start server ---
server.listen(PORT, () => {
  log("info", "✅ Server listening", { port: PORT });
  log("info", "💬 SMS endpoint", { method: "POST", url: `${PUBLIC_BASE_URL}/twiml/sms` });
  log("info", "🌐 Voice endpoint", { method: "POST", url: `${PUBLIC_BASE_URL}/twiml/voice` });
  log("info", "🧠 Init facts endpoint", { method: "POST", url: `${PUBLIC_BASE_URL}/init/facts` });
});
