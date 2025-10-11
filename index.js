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

// Cookie jar to persist Cloudflare challenge tokens, etc.
const cookieJar = new Tough.CookieJar();
const cookieFetch = fetchCookie(fetch, cookieJar);

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

const HTML_SNIPPET_LIMIT = parseInt(process.env.HTML_SNIPPET_LIMIT || "20000", 10);
const HTML_CACHE_TTL_SEC = parseInt(process.env.HTML_CACHE_TTL_SEC || "900", 10);

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || "";
const BROWSERLESS_REGION = process.env.BROWSERLESS_REGION || "production-sfo";
const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY || "";

// === Added Improvements ===
const OPENAI_COST_PER_1K = parseFloat(process.env.OPENAI_COST_PER_1K || "0"); // e.g. 0.15
const OPENAI_MAX_TOKENS = parseInt(process.env.OPENAI_MAX_TOKENS || "250", 10);
const HEADLESS_ALLOWLIST = (process.env.HEADLESS_ALLOWLIST || "").toLowerCase();
const HEADLESS_DENYLIST = (process.env.HEADLESS_DENYLIST || "").toLowerCase();

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
function timeStart(label) {
  return { label, t0: Date.now() };
}
function timeEnd(t, extra = {}) {
  const ms = Date.now() - t.t0;
  log("debug", `⏱️ ${t.label}`, { ms, ...extra });
}
function logEvent(evt, meta = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), evt, ...meta }));
}

// --- Rate limiter ---
const RL_BURST_SEC = 10;
const RL_PER_MIN = 6;
const rateLimiter = new Map();
function checkSmsRate(phone) {
  const now = Date.now();
  const e = rateLimiter.get(phone) || { last: 0, count: 0 };
  const elapsed = now - e.last;
  if (elapsed < RL_BURST_SEC * 1000) return false;
  if (elapsed > 60000) e.count = 0;
  e.last = now;
  e.count++;
  rateLimiter.set(phone, e);
  return e.count <= RL_PER_MIN;
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
    return [
      "ct.sendgrid.net",
      "cloudflare.com",
      "challenge.cloudflare.com",
      "bit.ly",
      "lnkd.in",
      "l.instagram.com",
      "linktr.ee",
    ].some((d) => h.endsWith(d));
  } catch {
    return true;
  }
}
function safeHost(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
}
const ADDRESS_REGEX =
  /([0-9]{2,5}\s?[A-Za-z0-9.'-]+\s?(Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Boulevard|Blvd|Lane|Ln|Court|Ct|Trail|Trl|Way|Place|Pl|SE|SW|NW|NE|Southeast|Southwest|Northeast|Northwest))/i;

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
async function getPropertyFactsBySlug(propertySlug) {
  const key = `facts:prop:${propertySlug}`;
  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : null;
}
async function setPropertyFactsBySlug(propertySlug, facts) {
  const key = `facts:prop:${propertySlug}`;
  await redis.set(key, JSON.stringify(facts));
  await redis.sadd("props:index", propertySlug);
  log("info", "💾 [Redis] Updated property facts", { property: propertySlug });
}
async function listAllPropertySlugs() {
  return await redis.smembers("props:index");
}
async function addPropertyForPhone(phone, propertySlug) {
  if (!phone || !propertySlug) return;
  await redis.sadd(`phoneprops:${phone}`, propertySlug);
}
async function getPropertiesForPhone(phone) {
  return (await redis.smembers(`phoneprops:${phone}`)) || [];
}
async function setLastPropertyForPhone(phone, propertySlug) {
  await redis.set(`lastprop:${phone}`, propertySlug);
}
async function getLastPropertyForPhone(phone) {
  return await redis.get(`lastprop:${phone}`);
}
async function setAskContext(phone, options) {
  await redis.setex(`ask:${phone}`, 900, JSON.stringify(options));
}
async function getAskContext(phone) {
  const raw = await redis.get(`ask:${phone}`);
  return raw ? JSON.parse(raw) : null;
}
async function clearAskContext(phone) {
  await redis.del(`ask:${phone}`);
}
async function cacheHtmlForProperty(propertySlug, html) {
  if (!html) return;
  await redis.setex(`html:${propertySlug}`, HTML_CACHE_TTL_SEC, html);
}
async function getCachedHtmlForProperty(propertySlug) {
  return await redis.get(`html:${propertySlug}`);
}

// --- Smart fetchers ---
const SIMPLE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-CA,en-US;q=0.9,en;q=0.8",
};

async function fetchDirectHTML(url) {
  const t = timeStart("[fetch] direct");
  try {
    const resp = await cookieFetch(url, { headers: SIMPLE_HEADERS, redirect: "follow" });
    const status = resp.status;
    if (!resp.ok) {
      log("warn", "⚠️ direct non-OK", {
        status,
        url,
        server: resp.headers.get("server"),
        cfRay: resp.headers.get("cf-ray"),
      });
      timeEnd(t, { ok: false, status });
      return { html: "", status };
    }
    const html = await resp.text();
    timeEnd(t, { ok: true, len: html.length });
    return { html, status };
  } catch (err) {
    timeEnd(t, { ok: false, error: err.message });
    return { html: "", status: 0 };
  }
}

function shouldUseHeadless(url, htmlLen, was403) {
  const host = safeHost(url);
  const allow = HEADLESS_ALLOWLIST.split(",").filter(Boolean);
  const deny = HEADLESS_DENYLIST.split(",").filter(Boolean);
  const matches = (list) => list.some((h) => host.includes(h.trim()));
  if (matches(deny)) return false;
  if (matches(allow)) return true;
  if (was403) return true;
  if ((htmlLen || 0) < 5000) return true;
  return false;
}

async function fetchListingHTML(url, propertySlug) {
  const cached = await getCachedHtmlForProperty(propertySlug);
  if (cached && cached.length >= 1200) {
    log("debug", "🗃️ [HTML cache] hit", { property: propertySlug, len: cached.length });
    return cached;
  }

  const direct = await fetchDirectHTML(url);
  const was403 = [401, 403, 503].includes(direct.status);

  if (!shouldUseHeadless(url, direct.html?.length, was403)) {
    if (direct.html && direct.html.length >= 1200) {
      await cacheHtmlForProperty(propertySlug, direct.html);
      return direct.html;
    }
  }

  let html = "";
  let fallbackUsed = null;

  if (shouldUseHeadless(url, direct.html?.length, was403)) {
    if (BROWSERLESS_TOKEN) {
      const blUrl = `https://chrome.browserless.io/content?token=${BROWSERLESS_TOKEN}&url=${encodeURIComponent(
        url
      )}&region=${BROWSERLESS_REGION}`;
      try {
        const r = await fetch(blUrl);
        if (r.ok) {
          html = await r.text();
          fallbackUsed = "browserless";
        }
      } catch (err) {
        log("warn", "⚠️ browserless error", { msg: err.message });
      }
    }

    if (!html && SCRAPINGBEE_API_KEY) {
      try {
        const beeUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_API_KEY}&url=${encodeURIComponent(
          url
        )}&render_js=true`;
        const r = await fetch(beeUrl);
        if (r.ok) {
          html = await r.text();
          fallbackUsed = "scrapingbee";
        }
      } catch (err) {
        log("warn", "⚠️ scrapingbee error", { msg: err.message });
      }
    }
  }

  if (!html && direct.html && direct.html.length >= 1200) html = direct.html;

  if (html?.length >= 1200) {
    await cacheHtmlForProperty(propertySlug, html);
  } else {
    log("warn", "⚠️ all fetchers failed or tiny HTML", {
      directStatus: direct.status,
      fallbackUsed,
      host: safeHost(url),
    });
  }

  logEvent("fetch.done", { url, len: html?.length || 0, fallbackUsed });
  return html;
}

// --- AI reasoning ---
async function aiReasonFromPage({ question, html, facts, url }) {
  try {
    const snippet = (html || "").slice(0, HTML_SNIPPET_LIMIT);
    const system = `
You are "Alex", a concise, friendly rental assistant.
You're given:
1) Known context (facts).
2) The rental page HTML.
3) The user's question.
Use evidence from HTML when possible. If not present, say "not mentioned". Keep under 3 sentences.`;

    const messages = [
      { role: "system", content: system },
      { role: "user", content: `FACTS:\n${JSON.stringify(facts)}` },
      { role: "user", content: `RENTAL PAGE URL:\n${url}` },
      { role: "user", content: `RENTAL PAGE HTML (truncated):\n${snippet}` },
      { role: "user", content: `QUESTION:\n${question}` },
    ];

    const t = timeStart("[ai] chat.completions");
    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: OPENAI_MAX_TOKENS,
      temperature: 0.3,
    });
    timeEnd(t);
    const reply = ai.choices?.[0]?.message?.content?.trim();

    const usage = ai.usage || {};
    const cost = OPENAI_COST_PER_1K
      ? ((usage.total_tokens / 1000) * OPENAI_COST_PER_1K).toFixed(4)
      : null;
    logEvent("openai.sms_answer", { tokens: usage, estCostUSD: cost });

    return reply || "Sorry—I couldn’t find that on the listing.";
  } catch (err) {
    log("error", "❌ aiReasonFromPage error", { error: err.message });
    return "Sorry—something went wrong reading the listing.";
  }
}

// --- Health check ---
app.get("/", (req, res) => res.send("✅ AI Rental Assistant is running"));

// --- Debug routes (unchanged) ---
app.get("/debug/facts", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  const slug = slugify(req.query.property || "");
  const facts = await getPropertyFactsBySlug(slug);
  res.json({ property: slug, facts });
});

app.get("/debug/phone", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  const phone = normalizePhone(req.query.phone);
  const props = await getPropertiesForPhone(phone);
  const last = await getLastPropertyForPhone(phone);
  const ask = await getAskContext(phone);
  res.json({ phone, properties: props, lastProperty: last, askContext: ask });
});

app.get("/debug/html", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  const slug = slugify(req.query.property || "");
  const cached = await getCachedHtmlForProperty(slug);
  if (!cached) return res.status(404).json({ error: "No cached HTML" });
  res.type("text/plain").send(cached.slice(0, 4000));
});

// --- init/facts, sms, voice, followups, ws sections unchanged except SMS limiter insertion ---

// ... keep your /init/facts etc ... then in /twiml/sms:

app.post("/twiml/sms", async (req, res) => {
  const from = normalizePhone(req.body.From);
  const body = req.body.Body?.trim() || "";
  log("info", "📩 SMS received", { from, body });
  if (!checkSmsRate(from)) {
    log("warn", "⚠️ SMS rate limit hit", { from });
    return res.type("text/xml").send("<Response></Response>");
  }
  // ... rest of your SMS logic unchanged ...
});

// --- Server start ---
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio-media") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  else socket.destroy();
});
wss.on("connection", (ws) => {
  log("info", "🔊 Twilio media stream connected!");
});
server.listen(PORT, () => {
  log("info", "✅ Server listening", { port: PORT });
});
