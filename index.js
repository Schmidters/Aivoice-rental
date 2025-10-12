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

// --- Cookie-aware fetch setup ---
const cookieJar = new Tough.CookieJar();
const cookieFetch = fetchCookie(fetch, cookieJar);

// --- Express setup ---
const app = express();
// Twilio sends application/x-www-form-urlencoded by default
app.use(express.text({ type: "text/*" }));
app.use(express.urlencoded({ extended: true }));
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

// Browse AI
const BROWSEAI_KEY = process.env.BROWSEAI_KEY || process.env.BROWSEAI_API_KEY || "";
const BROWSEAI_ROBOT_ID = process.env.BROWSEAI_ROBOT_ID || "";
const BROWSEAI_WEBHOOK_SECRET = process.env.BROWSEAI_WEBHOOK_SECRET || ""; // optional

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
  if (!phone || !slug) return;
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
async function mapUrlToSlug(url, slug) {
  if (!url || !slug) return;
  await redis.set(`url2slug:${url}`, slug, "EX", 60 * 60 * 24 * 7);
}
async function getSlugByUrl(url) {
  if (!url) return null;
  return await redis.get(`url2slug:${url}`);
}

// --- Direct HTML Fetcher only (Browserless & ScrapingBee removed) ---
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

async function fetchListingHTML(url, slug) {
  const cached = await getCachedHtmlForProperty(slug);
  if (cached && cached.length >= 1000) return cached;

  const direct = await fetchDirectHTML(url);
  const tooSmall = (direct.html || "").length < 1000;
  if (!tooSmall) {
    await cacheHtmlForProperty(slug, direct.html);
    return direct.html;
  }

  log("warn", "⚠️ fetchListingHTML: tiny/empty HTML and no other fetchers enabled", { url });
  return "";
}

// --- Browse AI integration (runs + webhook) ---
async function triggerBrowseAITask(url) {
  if (!BROWSEAI_KEY || !BROWSEAI_ROBOT_ID) {
    log("warn", "⚠️ BrowseAI not configured");
    return null;
  }
  try {
    const resp = await fetch(`https://api.browse.ai/v2/robots/${BROWSEAI_ROBOT_ID}/tasks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BROWSEAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputParameters: { "Origin URL": url } }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      log("warn", "⚠️ BrowseAI task create non-OK", { status: resp.status, data });
      return null;
    }
    log("info", "🤖 [BrowseAI] Task created", { id: data?.id || data?.data?.id || "unknown" });
    return data;
  } catch (e) {
    log("error", "❌ BrowseAI task error", { error: e.message });
    return null;
  }
}

// --- AI reasoning (prefers BrowseAI facts, falls back to HTML) ---
async function aiReasonFromSources({ question, facts, html, url }) {
  try {
    const snippet = (html || "").slice(0, HTML_SNIPPET_LIMIT);
    const system = `You are "Alex", a concise, friendly rental assistant. 
Use the structured FACTS first. 
If something isn't in FACTS, you may consult the HTML snippet. 
Be brief and helpful. If unknown, say so and offer to check.`;

    const messages = [
      { role: "system", content: system },
      { role: "user", content: `FACTS:\n${JSON.stringify(facts || {}, null, 2)}` },
      { role: "user", content: `URL:\n${url || "n/a"}` },
      { role: "user", content: `HTML_SNIPPET:\n${snippet}` },
      { role: "user", content: `QUESTION:\n${question}` },
    ];

    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 250,
      temperature: 0.2,
    });
    return ai.choices?.[0]?.message?.content?.trim() || "Not mentioned in the listing.";
  } catch (err) {
    log("error", "❌ aiReasonFromSources error", { error: err.message });
    return "Sorry—something went wrong while checking the listing.";
  }
}

// --- Health check ---
app.get("/", (req, res) => res.send("✅ AI Rental Assistant is running"));

// --- Init facts (Zapier/manual) ---
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
      source: "init/facts",
    };
    await setPropertyFactsBySlug(slug, facts);
    if (finalUrl) await mapUrlToSlug(finalUrl, slug);
    if (html && html.length > 200) await cacheHtmlForProperty(slug, html);

    const prospect = normalizePhone(leadPhone || phone);
    if (prospect) {
      await addPropertyForPhone(prospect, slug);
      await setLastPropertyForPhone(prospect, slug);
    }
    res.json({ success: true, property: slug, data: facts });
  } catch (e) {
    log("error", "❌ /init/facts error", { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// --- Manual trigger to run BrowseAI for a URL and bind it to a property ---
app.post("/init/fetch", async (req, res) => {
  try {
    const { property, url } = req.body;
    if (!property || !url) return res.status(400).json({ error: "Need property + url" });
    const slug = slugify(property);
    await mapUrlToSlug(url, slug);
    const task = await triggerBrowseAITask(url);
    res.json({ ok: true, slug, taskId: task?.id || task?.data?.id || null });
  } catch (e) {
    log("error", "❌ /init/fetch error", { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// Simple test route so we can confirm Render is reachable
app.post("/browseai/test", async (req, res) => {
  log("info", "✅ Test webhook hit", { body: req.body });
  res.json({ ok: true, received: req.body || "no body" });
});

// --- Browse AI webhook (preferred data path) ---
app.post("/browseai/webhook", async (req, res) => {
  try {
    if (BROWSEAI_WEBHOOK_SECRET) {
      const sig = req.headers["x-browseai-secret"];
      if (sig !== BROWSEAI_WEBHOOK_SECRET) return res.status(401).send("unauthorized");
    }

    const payload = req.body || {};
    log("info", "📦 [Webhook] BrowseAI data received");

    // Try to derive slug
    const originUrl =
      payload?.inputParameters?.["Origin URL"] ||
      payload?.results?.["Origin URL"] ||
      payload?.input?.startUrls?.[0] ||
      null;

    let slug = originUrl ? await getSlugByUrl(originUrl) : null;

    // Fallback: attempt to extract from results summary/title
    if (!slug) {
      const nameGuess =
        payload?.results?.address ||
        payload?.results?.Summary ||
        payload?.results?.["Title Summary"] ||
        payload?.results?.Title ||
        "unknown-property";
      slug = slugify(String(nameGuess));
    }

    const facts = {
      ...(payload?.results || payload?.data || payload),
      listingUrl: originUrl || (payload?.results && payload.results["Origin URL"]) || null,
      updatedAt: nowIso(),
      source: "browseai",
    };

    await setPropertyFactsBySlug(slug, facts);
    if (facts.listingUrl) await mapUrlToSlug(facts.listingUrl, slug);

    res.json({ ok: true, slug });
  } catch (err) {
    log("error", "❌ [Webhook error]", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// --- Twilio SMS ---
app.post("/twiml/sms", async (req, res) => {
  const from = normalizePhone(req.body.From);
  const body = req.body.Body?.trim() || "";
  log("info", "📩 SMS received", { from, body });
  // immediately ack Twilio
  res.type("text/xml").send("<Response></Response>");

  try {
    // Determine the active property for this number
    let slug = await getLastPropertyForPhone(from);
    if (!slug) {
      const props = await getPropertiesForPhone(from);
      slug = props && props[0];
    }
    if (!slug) {
      // ask user to share link or address
      await twilioClient.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to: from,
        body: "Got your message! Send me the property link or address so I can pull details.",
      });
      return;
    }

    // Load best-available sources
    const facts = await getPropertyFactsBySlug(slug);
    const url = facts?.listingUrl || null;
    let html = await getCachedHtmlForProperty(slug);

    // If we have a URL but no html cached, try direct fetch (only once here)
    if (url && !html) {
      const t = timeStart("directFetch");
      const fresh = await fetchListingHTML(url, slug);
      timeEnd(t, { bytes: fresh?.length || 0 });
      html = fresh;
    }

    const answer = await aiReasonFromSources({
      question: body,
      facts,
      html,
      url: url || "n/a",
    });

    await twilioClient.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to: from,
      body: answer,
    });
    log("info", "✅ SMS reply sent", { to: from, slug });
  } catch (err) {
    log("error", "❌ SMS send error", { error: err.message });
  }
});

// --- Voice (unchanged) ---
app.post("/twiml/voice", (req, res) => {
  const twiml = `<Response>
    <Connect><Stream url="wss://${new URL(PUBLIC_BASE_URL).host}/twilio-media" /></Connect>
    <Say voice="Polly.Joanna">Hi, connecting you to the rental assistant now.</Say>
  </Response>`;
  res.type("text/xml").send(twiml);
});

// --- Debug routes ---
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

// --- WebSocket (Twilio media stream placeholder) ---
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio-media") wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  else socket.destroy();
});
wss.on("connection", ws => {
  log("info", "🔊 Twilio media stream connected!");
});

// --- Start server ---
server.listen(PORT, () => {
  log("info", "✅ Server listening", { port: PORT });
  log("info", "💬 SMS endpoint", { method: "POST", url: `${PUBLIC_BASE_URL}/twiml/sms` });
  log("info", "🌐 Voice endpoint", { method: "POST", url: `${PUBLIC_BASE_URL}/twiml/voice` });
  log("info", "🧠 Init facts endpoint", { method: "POST", url: `${PUBLIC_BASE_URL}/init/facts` });
  log("info", "🤖 BrowseAI webhook", { method: "POST", url: `${PUBLIC_BASE_URL}/browseai/webhook` });
  log("info", "🔍 Init fetch (BrowseAI)", { method: "POST", url: `${PUBLIC_BASE_URL}/init/fetch` });
});
