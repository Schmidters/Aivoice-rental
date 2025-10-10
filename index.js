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
const BROWSERLESS_KEY = process.env.BROWSERLESS_KEY;

const DEBUG_LEVEL = (process.env.DEBUG_LEVEL || "info").toLowerCase(); // "debug" | "info" | "warn" | "error"
const HTML_MAX_AGE_MIN = parseInt(process.env.HTML_MAX_AGE_MIN || "1440", 10); // 24h default
const HTML_SNIPPET_LIMIT = parseInt(process.env.HTML_SNIPPET_LIMIT || "20000", 10);

// --- Clients ---
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const redis = new Redis(REDIS_URL, { tls: false });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- Small utils ---
const nowIso = () => new Date().toISOString();
const uid = () => Math.random().toString(36).slice(2, 8);
const hr = () => "—".repeat(56);

function log(level, msg, meta = {}) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  if (levels[level] < levels[DEBUG_LEVEL]) return;
  const payload = { ts: nowIso(), level, msg, ...meta };
  console.log(JSON.stringify(payload));
}
function timeStart(label) {
  return { label, t0: Date.now() };
}
function timeEnd(t, extra = {}) {
  const ms = Date.now() - t.t0;
  log("debug", `⏱️ ${t.label}`, { ms, ...extra });
}

// --- Phone + slug helpers ---
function normalizePhone(phone) {
  if (!phone) return null;
  const parsed = parsePhoneNumberFromString(phone, "CA");
  return parsed && parsed.isValid() ? parsed.number : phone;
}
function slugify(str) {
  return str ? str.replace(/\s+/g, "-").replace(/[^\w\-]/g, "").toLowerCase() : "unknown";
}

// --- SendGrid cleaner & redirect extractors ---
function cleanListingUrl(url) {
  try {
    const m = url.match(/upn=([^&]+)/);
    if (!m) return url;
    let decoded = decodeURIComponent(m[1]);
    try { decoded = decodeURIComponent(decoded); } catch (_) {}
    const real = decoded.match(/https?:\/\/[^\s"'<>()]+/);
    const clean = real ? real[0] : url;
    log("info", "🔗 [URL-Clean]", { original: url, clean });
    return clean;
  } catch (err) {
    log("warn", "⚠️ [URL-Clean] Failed to decode", { error: err.message });
    return url;
  }
}

// Try to extract a real destination from interstitial HTML (SendGrid/tracking pages).
function extractRedirectFromHtml(html) {
  if (!html) return null;

  // 1) <meta http-equiv="refresh" content="0; URL=https://...">
  const meta = html.match(/http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'>\s]+)/i);
  if (meta && meta[1]) return meta[1];

  // 2) Anchor "click here"/"redirect" links
  const link = html.match(/<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>(?:[^<]*redirect[^<]*|[^<]*click[^<]*here[^<]*)<\/a>/i);
  if (link && link[1]) return link[1];

  // 3) window.location assignments
  const js1 = html.match(/location\.replace\(['"]([^'"]+)['"]\)/i);
  if (js1 && js1[1]) return js1[1];

  const js2 = html.match(/window\.location\s*=\s*['"]([^'"]+)['"]/i);
  if (js2 && js2[1]) return js2[1];

  return null;
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

// HTML cache
async function getCachedHTML(finalUrl) {
  const key = `html:${finalUrl}`;
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed;
  } catch {
    return null;
  }
}
async function setCachedHTML(finalUrl, html) {
  const key = `html:${finalUrl}`;
  const payload = { html, fetchedAt: nowIso() };
  await redis.set(key, JSON.stringify(payload));
  log("info", "🗃️ [Cache] Stored HTML", { finalUrl, length: html.length });
}

// --- Browserless fetchers ---
async function fetchWithBrowserlessContent(url, reqId) {
  const endpoint = `https://production-sfo.browserless.io/content?token=${BROWSERLESS_KEY}`;
  const payload = {
    url,
    gotoOptions: { waitUntil: "networkidle2" },
    rejectResourceTypes: ["image", "media", "font", "stylesheet"],
    bestAttempt: true,
    waitForTimeout: 6000
  };
  const t = timeStart(`[${reqId}] POST /content`);
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Cache-Control": "no-cache", "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  timeEnd(t, { status: resp.status });
  return resp;
}

async function fetchWithBrowserlessUnblock(url, reqId) {
  const endpoint = `https://production-sfo.browserless.io/unblock?token=${BROWSERLESS_KEY}`;
  const payload = { url };
  const t = timeStart(`[${reqId}] POST /unblock`);
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  timeEnd(t, { status: resp.status });
  return resp;
}

// getOrFetchListingHTML: returns { html, finalUrl, source }
async function getOrFetchListingHTML(listingUrl, { reqId = "no-reqid" } = {}) {
  if (!BROWSERLESS_KEY) {
    log("warn", "⚠️ No BROWSERLESS_KEY — cannot fetch listing HTML");
    return { html: "", finalUrl: listingUrl, source: "none" };
  }

  let cleanUrl = cleanListingUrl(listingUrl);

  // Check cache for cleaned URL
  const cached1 = await getCachedHTML(cleanUrl);
  if (cached1?.html && cached1?.fetchedAt) {
    const ageMin = (Date.now() - new Date(cached1.fetchedAt).getTime()) / 60000;
    if (ageMin <= HTML_MAX_AGE_MIN) {
      log("info", "🗃️ [Cache] Using cached HTML", { url: cleanUrl, ageMin: Math.round(ageMin) });
      return { html: cached1.html, finalUrl: cleanUrl, source: "cache" };
    }
    log("info", "♻️ [Cache] Cached HTML stale, refreshing", { url: cleanUrl, ageMin: Math.round(ageMin) });
  } else {
    log("info", "🔍 [Cache] No cached HTML, fetching", { url: cleanUrl });
  }

  // 1st request (content)
  let resp = await fetchWithBrowserlessContent(cleanUrl, reqId);
  if (!resp.ok) {
    const txt = await resp.text();
    log("warn", "❌ [/content] failed", { status: resp.status, sample: txt?.slice(0, 300) });
    // fallback: unblock
    resp = await fetchWithBrowserlessUnblock(cleanUrl, reqId);
    if (!resp.ok) {
      const txt2 = await resp.text();
      log("error", "❌ [/unblock] failed", { status: resp.status, sample: txt2?.slice(0, 300) });
      return { html: "", finalUrl: cleanUrl, source: "error" };
    }
  }

  let html = await resp.text();
  if (!html) return { html: "", finalUrl: cleanUrl, source: "empty" };

  // Detect interstitial / follow redirect
  const looksInterstitial =
    /sendgrid\.net|utm_source=|redirect/i.test(cleanUrl) ||
    /http-equiv=["']?refresh|location\.replace|window\.location/i.test(html);

  if (looksInterstitial) {
    const to = extractRedirectFromHtml(html);
    if (to && to !== cleanUrl) {
      log("info", "🔁 [Redirect] Interstitial detected, following", { from: cleanUrl, to });
      cleanUrl = to;

      // Cache check on final URL
      const cached2 = await getCachedHTML(cleanUrl);
      if (cached2?.html && cached2?.fetchedAt) {
        const ageMin2 = (Date.now() - new Date(cached2.fetchedAt).getTime()) / 60000;
        if (ageMin2 <= HTML_MAX_AGE_MIN) {
          log("info", "🗃️ [Cache] Using cached HTML (final URL)", {
            url: cleanUrl,
            ageMin: Math.round(ageMin2)
          });
          return { html: cached2.html, finalUrl: cleanUrl, source: "cache" };
        }
        log("info", "♻️ [Cache] Final URL cache stale, refreshing", { url: cleanUrl });
      }

      // Refetch final URL
      let resp2 = await fetchWithBrowserlessContent(cleanUrl, reqId);
      if (!resp2.ok) {
        const txt3 = await resp2.text();
        log("warn", "❌ [/content] final URL failed", { status: resp2.status, sample: txt3?.slice(0, 300) });
        resp2 = await fetchWithBrowserlessUnblock(cleanUrl, reqId);
        if (!resp2.ok) {
          const txt4 = await resp2.text();
          log("error", "❌ [/unblock] final URL failed", { status: resp2.status, sample: txt4?.slice(0, 300) });
          // last resort: return interstitial HTML
          log("warn", "⚠️ Using interstitial HTML as last resort");
          await setCachedHTML(cleanUrl, html); // still cache it so we see it later in debug
          return { html, finalUrl: cleanUrl, source: "fetch-interstitial" };
        }
      }
      html = await resp2.text();
    }
  }

  await setCachedHTML(cleanUrl, html);
  return { html, finalUrl: cleanUrl, source: "fetch" };
}

// --- Reasoning helper: answer user question from HTML + facts ---
async function aiReasonFromPage({ question, html, facts, finalUrl, reqId }) {
  try {
    const snippet = (html || "").slice(0, HTML_SNIPPET_LIMIT);
    const sys = `
You are "Alex", a concise, friendly rental assistant.
You are given:
1) FULL rental page HTML (truncated)
2) Known context for this lead (facts)
3) The user's question.

Answer using evidence from the HTML when possible. If not explicit, say "not mentioned" or explain uncertainty.
Keep replies under 3 sentences.`.trim();

    const messages = [
      { role: "system", content: sys },
      { role: "user", content: `FACTS JSON:\n${JSON.stringify(facts)}` },
      { role: "user", content: `RENTAL PAGE URL:\n${finalUrl || "unknown"}` },
      { role: "user", content: `RENTAL PAGE HTML (truncated):\n${snippet}` },
      { role: "user", content: `QUESTION:\n${question}` }
    ];

    const t = timeStart(`[${reqId}] openai.chat.completions`);
    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 250,
      temperature: 0.3
    });
    timeEnd(t);
    const reply = ai.choices?.[0]?.message?.content?.trim();
    return reply || "Sorry—I couldn’t find that on the listing.";
  } catch (err) {
    log("error", "❌ [aiReasonFromPage] Error", { error: err.message, reqId });
    return "Sorry—something went wrong reading the listing.";
  }
}

// --- Health check ---
app.get("/", (req, res) => res.send("✅ AI Rental Assistant is running"));

// --- Debug routes ---
function ensureAuth(req, res) {
  if (req.query.key !== DEBUG_SECRET) {
    res.status(401).send("Unauthorized");
    return false;
  }
  return true;
}

app.get("/debug/facts", async (req, res) => {
  if (!ensureAuth(req, res)) return;
  const { phone, property } = req.query;
  if (!phone) return res.status(400).send("Missing phone");
  const slug = property ? slugify(property) : "unknown";
  const facts = await getPropertyFacts(phone, slug);
  res.json({ phone, property: slug, facts });
});

// Inspect cached HTML
app.get("/debug/html", async (req, res) => {
  if (!ensureAuth(req, res)) return;
  const { url } = req.query;
  if (!url) return res.status(400).send("Missing url");
  const clean = cleanListingUrl(url);
  const cached = await getCachedHTML(clean);
  if (!cached) return res.json({ url: clean, cached: false });
  res.json({
    url: clean,
    cached: true,
    fetchedAt: cached.fetchedAt,
    length: cached.html?.length || 0,
    preview: cached.html?.slice(0, 400) || ""
  });
});

// Force refresh HTML cache
app.post("/debug/html/refresh", async (req, res) => {
  if (!ensureAuth(req, res)) return;
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "Missing url" });
  const reqId = `refresh_${uid()}`;
  const { html, finalUrl, source } = await getOrFetchListingHTML(url, { reqId });
  res.json({
    ok: !!html,
    finalUrl,
    source,
    length: html?.length || 0
  });
});

// Clear a specific cache entry (facts + html)
app.post("/debug/clear", async (req, res) => {
  if (!ensureAuth(req, res)) return;
  const { phone, property, url } = req.body || {};
  const ops = [];
  if (phone && property) {
    const slug = slugify(property);
    ops.push(redis.del(`conv:${phone}:${slug}`, `facts:${phone}:${slug}`, `meta:${phone}:${slug}`));
  }
  if (url) {
    const clean = cleanListingUrl(url);
    ops.push(redis.del(`html:${clean}`));
  }
  await Promise.all(ops);
  res.json({ ok: true });
});

// --- Initialize property facts (from Zapier) ---
// Warms the HTML cache so first SMS is fast.
app.post("/init/facts", async (req, res) => {
  const reqId = `init_${uid()}`;
  try {
    let { phone, property, listingUrl, rent, unit } = req.body;
    if (!phone || !property) {
      return res.status(400).json({ error: "Missing phone or property" });
    }

    phone = normalizePhone(phone);
    const slug = slugify(property);

    const facts = {
      phone,
      property: slug,
      address: property,
      rent: rent || null,
      unit: unit || null,
      listingUrl: listingUrl || null,
      initializedAt: nowIso()
    };

    await setPropertyFacts(phone, slug, facts);
    log("info", "💾 [Init] Facts initialized", { phone, property: slug, facts });

    let htmlInfo = null;
    if (listingUrl) {
      const t = timeStart(`[${reqId}] warm-html`);
      const { html, finalUrl, source } = await getOrFetchListingHTML(listingUrl, { reqId });
      timeEnd(t, { finalUrl, source, len: html?.length || 0 });
      htmlInfo = { finalUrl, source, length: html?.length || 0 };
    }

    res.status(200).json({
      success: true,
      message: "Initialized; HTML cache warmed if URL present.",
      data: facts,
      redisKey: `facts:${phone}:${slug}`,
      htmlInfo
    });
  } catch (err) {
    log("error", "❌ /init/facts error", { error: err.message, reqId });
    res.status(500).json({ error: err.message });
  }
});

// --- Voice webhook ---
app.post("/twiml/voice", (req, res) => {
  const twiml = `
<Response>
  <Connect><Stream url="wss://aivoice-rental.onrender.com/twilio-media" /></Connect>
  <Say voice="Polly.Joanna">Hi, connecting you to the rental assistant now.</Say>
</Response>`.trim();
  res.type("text/xml").send(twiml);
});

// --- SMS webhook (dynamic reasoning from page) ---
app.post("/twiml/sms", async (req, res) => {
  const reqId = `sms_${uid()}`;
  const from = normalizePhone(req.body.From);
  const body = req.body.Body?.trim() || "";
  log("info", "📩 SMS received", { from, body, reqId });
  res.type("text/xml").send("<Response></Response>");

  try {
    // Heuristic: try to infer property slug from message; default to "unknown".
    const propertyRegex =
      /([0-9]{2,5}\s?[A-Za-z]+\s?(Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|SE|SW|NW|NE|Southeast|Southwest|Northeast|Northwest))/i;
    const match = body.match(propertyRegex);
    const propertySlug = slugify(match ? match[0] : "unknown");

    const prev = await getConversation(from, propertySlug);
    const facts = await getPropertyFacts(from, propertySlug);

    let reply = "";
    if (facts?.listingUrl) {
      const { html, finalUrl, source } = await getOrFetchListingHTML(facts.listingUrl, { reqId });
      log("info", "📄 [Reasoning] HTML ready", { finalUrl, source, length: html?.length || 0, reqId });
      if (html) {
        reply = await aiReasonFromPage({ question: body, html, facts, finalUrl, reqId });
      } else {
        // Fallback: known facts only
        const sys = {
          role: "system",
          content: `You are Alex, a friendly rental assistant. Known facts: ${JSON.stringify(facts)}.
If info isn't present, say "not mentioned". Keep replies under 3 sentences.`
        };
        const msgs = [sys, ...prev, { role: "user", content: body }];
        const t = timeStart(`[${reqId}] openai.chat.fallback`);
        const ai = await openai.chat.completions.create({ model: "gpt-4o-mini", messages: msgs, max_tokens: 180 });
        timeEnd(t);
        reply = ai.choices?.[0]?.message?.content?.trim() || "Sorry—I couldn't load the listing just now.";
      }
    } else {
      // No URL yet; answer from facts only
      const sys = {
        role: "system",
        content: `You are Alex, a friendly rental assistant. Known facts: ${JSON.stringify(facts)}.
If info isn't present, say "not mentioned". Keep replies under 3 sentences.`
      };
      const msgs = [sys, ...prev, { role: "user", content: body }];
      const t = timeStart(`[${reqId}] openai.chat.no-url`);
      const ai = await openai.chat.completions.create({ model: "gpt-4o-mini", messages: msgs, max_tokens: 180 });
      timeEnd(t);
      reply = ai.choices?.[0]?.message?.content?.trim() || "Could you share the property address or link?";
    }

    log("info", "💬 GPT reply", { reply, reqId });
    const updated = [...prev, { role: "user", content: body }, { role: "assistant", content: reply }];
    await saveConversation(from, propertySlug, updated);
    await twilioClient.messages.create({ from: TWILIO_PHONE_NUMBER, to: from, body: reply });
    log("info", "✅ SMS sent", { to: from, reqId });
  } catch (err) {
    log("error", "❌ SMS error", { error: err.message, reqId });
  }
});

// --- WebSocket for voice streaming ---
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
  log("info", hr());
});
