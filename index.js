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
import Tough from "tough-cookie";
import fetchCookie from "fetch-cookie";

const cookieJar = new Tough.CookieJar();
const cookieFetch = fetchCookie(fetch, cookieJar);

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
const DEBUG_LEVEL = (process.env.DEBUG_LEVEL || "info").toLowerCase();
const HTML_SNIPPET_LIMIT = parseInt(process.env.HTML_SNIPPET_LIMIT || "20000", 10);
const HTML_CACHE_TTL_SEC = parseInt(process.env.HTML_CACHE_TTL_SEC || "900", 10);
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || "";
const BROWSERLESS_REGION = process.env.BROWSERLESS_REGION || "production-sfo";
const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY || "";
const ALLOW_DOMAINS = (process.env.ALLOW_DOMAINS || "rentals.ca,airbnb.ca,kijiji.ca").split(",");
const DENY_DOMAINS = (process.env.DENY_DOMAINS || "ct.sendgrid.net,cloudflare.com").split(",");

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

// --- Utilities ---
function normalizePhone(phone) {
  if (!phone) return null;
  const parsed = parsePhoneNumberFromString(phone, "CA");
  return parsed && parsed.isValid() ? parsed.number : phone;
}
function slugify(str) {
  return str ? str.replace(/\s+/g, "-").replace(/[^\w\-]/g, "").toLowerCase() : "unknown";
}
function isTracker(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return DENY_DOMAINS.some(d => h.endsWith(d));
  } catch {
    return true;
  }
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
async function getPropertyFactsBySlug(slug) {
  const raw = await redis.get(`facts:prop:${slug}`);
  return raw ? JSON.parse(raw) : null;
}
async function setPropertyFactsBySlug(slug, facts) {
  await redis.set(`facts:prop:${slug}`, JSON.stringify(facts));
  await redis.sadd("props:index", slug);
  log("info", "💾 [Redis] Updated property facts", { property: slug });
}
async function addPropertyForPhone(phone, slug) {
  await redis.sadd(`phoneprops:${phone}`, slug);
}
async function getPropertiesForPhone(phone) {
  return (await redis.smembers(`phoneprops:${phone}`)) || [];
}
async function setLastPropertyForPhone(phone, slug) {
  await redis.set(`lastprop:${phone}`, slug);
}
async function getLastPropertyForPhone(phone) {
  return await redis.get(`lastprop:${phone}`);
}
async function cacheHtmlForProperty(slug, html) {
  if (!html) return;
  await redis.setex(`html:${slug}`, HTML_CACHE_TTL_SEC, html);
}
async function getCachedHtmlForProperty(slug) {
  return await redis.get(`html:${slug}`);
}

// --- Fetchers ---
const SIMPLE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-CA,en-US;q=0.9,en;q=0.8",
};

async function fetchDirectHTML(url) {
  try {
    const resp = await cookieFetch(url, { headers: SIMPLE_HEADERS, redirect: "follow" });
    const html = await resp.text();
    if (!resp.ok) {
      log("warn", "⚠️ direct non-OK", { status: resp.status, url });
      return { html: "", status: resp.status };
    }
    return { html, status: resp.status };
  } catch (e) {
    log("warn", "⚠️ direct fetch error", { url, error: e.message });
    return { html: "", status: 0 };
  }
}
async function fetchWithBrowserless(url) {
  if (!BROWSERLESS_TOKEN) return { html: "", used: false };
  const endpoint = `https://${BROWSERLESS_REGION}.browserless.io/content?token=${encodeURIComponent(
    BROWSERLESS_TOKEN
  )}`;
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, waitFor: "networkidle0", headers: SIMPLE_HEADERS }),
    });
    if (!resp.ok) return { html: "", used: true };
    return { html: await resp.text(), used: true };
  } catch {
    return { html: "", used: true };
  }
}
async function fetchWithScrapingBee(url) {
  if (!SCRAPINGBEE_API_KEY) return { html: "", used: false };
  const params = new URLSearchParams({
    api_key: SCRAPINGBEE_API_KEY,
    url,
    render_js: "true",
    wait: "networkidle0",
    country_code: "CA",
  });
  const beeUrl = `https://app.scrapingbee.com/api/v1/?${params}`;
  try {
    const resp = await fetch(beeUrl, { headers: SIMPLE_HEADERS });
    if (!resp.ok) return { html: "", used: true };
    return { html: await resp.text(), used: true };
  } catch {
    return { html: "", used: true };
  }
}
async function fetchListingHTML(url, slug) {
  const cached = await getCachedHtmlForProperty(slug);
  if (cached && cached.length >= 1000) return cached;

  const direct = await fetchDirectHTML(url);
  const blocked = [401, 403, 503].includes(direct.status);
  const tooSmall = (direct.html || "").length < 1000;
  if (!blocked && !tooSmall) {
    await cacheHtmlForProperty(slug, direct.html);
    return direct.html;
  }

  const bl = await fetchWithBrowserless(url);
  if (bl.used && bl.html.length >= 1000) {
    await cacheHtmlForProperty(slug, bl.html);
    return bl.html;
  }

  const bee = await fetchWithScrapingBee(url);
  if (bee.used && bee.html.length >= 1000) {
    await cacheHtmlForProperty(slug, bee.html);
    return bee.html;
  }

  log("warn", "⚠️ all fetchers failed or tiny HTML", { url });
  return "";
}

// --- AI reasoning ---
async function aiReasonFromPage({ question, html, facts, url }) {
  try {
    const snippet = (html || "").slice(0, HTML_SNIPPET_LIMIT);
    const system = `You are "Alex", a concise, friendly rental assistant. Use the facts and HTML to answer tenant questions briefly.`;
    const messages = [
      { role: "system", content: system },
      { role: "user", content: `FACTS:\n${JSON.stringify(facts)}` },
      { role: "user", content: `URL:\n${url}` },
      { role: "user", content: `HTML:\n${snippet}` },
      { role: "user", content: `QUESTION:\n${question}` },
    ];
    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 250,
      temperature: 0.3,
    });
    return ai.choices?.[0]?.message?.content?.trim() || "Not mentioned on the listing.";
  } catch (err) {
    log("error", "❌ aiReasonFromPage error", { error: err.message });
    return "Sorry—something went wrong reading the listing.";
  }
}

// --- Routes ---
app.get("/", (req, res) => res.send("✅ AI Rental Assistant is running"));

// Initialize property facts (Zapier)
app.post("/init/facts", async (req, res) => {
  try {
    let { leadPhone, phone, property, finalUrl, rent, unit, html } = req.body;
    if (!property) return res.status(400).json({ error: "Missing property" });
    const slug = slugify(property);
    if (finalUrl && isTracker(finalUrl))
      return res.status(422).json({ error: "Tracking/interstitial URL provided.", got: finalUrl });

    const facts = {
      address: property,
      rent: rent || null,
      unit: unit || null,
      listingUrl: finalUrl || null,
      initializedAt: nowIso(),
    };
    await setPropertyFactsBySlug(slug, facts);
    if (html && html.length > 200) {
      await cacheHtmlForProperty(slug, html);
      log("info", "🗃️ [HTML cache] snapshot stored", { property: slug });
    }
    const prospect = normalizePhone(leadPhone || phone);
    if (prospect) await addPropertyForPhone(prospect, slug);
    res.json({ success: true, property: slug, data: facts });
  } catch (e) {
    log("error", "❌ /init/facts error", { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// Twilio Voice (placeholder)
app.post("/twiml/voice", (req, res) => {
  const twiml = `<Response>
    <Connect><Stream url="wss://aivoice-rental.onrender.com/twilio-media" /></Connect>
    <Say voice="Polly.Joanna">Hi, connecting you to the rental assistant now.</Say>
  </Response>`;
  res.type("text/xml").send(twiml);
});

// Debug routes
app.get("/debug/facts", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  const slug = slugify(req.query.property || "");
  const facts = await getPropertyFactsBySlug(slug);
  res.json({ slug, facts });
});
app.get("/debug/html", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  const slug = slugify(req.query.property || "");
  const html = await getCachedHtmlForProperty(slug);
  if (!html) return res.status(404).send("No cached HTML");
  res.type("text/plain").send(html.slice(0, 4000));
});
app.post("/debug/clear", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  await redis.flushdb();
  res.json({ ok: true });
});

// --- WebSocket / Server start ---
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio-media") wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  else socket.destroy();
});
wss.on("connection", ws => {
  log("info", "🔊 Twilio media stream connected!");
  ws.on("message", msg => log("debug", "WS msg", { len: msg.length }));
});

server.listen(PORT, () => {
  log("info", "✅ Server listening", { port: PORT });
  log("info", "💬 SMS endpoint", { method: "POST", url: `${PUBLIC_BASE_URL}/twiml/sms` });
  log("info", "🌐 Voice endpoint", { method: "POST", url: `${PUBLIC_BASE_URL}/twiml/voice` });
  log("info", "🧠 Init facts endpoint", { method: "POST", url: `${PUBLIC_BASE_URL}/init/facts` });
});
