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

// BrowseAI
const BROWSEAI_KEY = process.env.BROWSEAI_KEY || process.env.BROWSEAI_API_KEY || "";
const BROWSEAI_ROBOT_ID = process.env.BROWSEAI_ROBOT_ID || "";
const BROWSEAI_WEBHOOK_SECRET = process.env.BROWSEAI_WEBHOOK_SECRET || "";

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

// --- Text cleanup + freshness helpers ---
function cleanText(str = "") {
  if (!str) return "";
  return str
    .replace(/\s+/g, " ")
    .replace(/Not Included/i, "not included")
    .replace(/Included/i, "included")
    .replace(/Garage parking/i, "garage parking")
    .trim();
}
function isRecent(facts) {
  if (!facts || !facts.updatedAt) return false;
  const ageMs = Date.now() - new Date(facts.updatedAt).getTime();
  return ageMs < 24 * 60 * 60 * 1000;
}

// --- Redis helpers ---
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

// --- Direct HTML Fetcher ---
const SIMPLE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
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
  log("warn", "⚠️ fetchListingHTML: tiny/empty HTML", { url });
  return "";
}

// --- BrowseAI integration ---
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
      body: JSON.stringify({ inputParameters: { originUrl: url, "Origin URL": url } }),
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

// --- AI reasoning ---
async function aiReasonFromSources({ question, facts, html, url }) {
  try {
    const snippet = (html || "").slice(0, HTML_SNIPPET_LIMIT);
    const system = `
You are "Alex", a natural and professional rental assistant for a property management company.
Speak like a real human texting — short, natural sentences, no robotic tone.
Use the structured FACTS first. Only rely on the HTML snippet if needed.
Be conversational and confident, but don't guess. 
If you don’t know something, say something like:
"Let me double-check that for you" or "I’ll confirm that and get back to you."
Keep answers under 2 sentences when possible.`;
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
      temperature: 0.3,
    });
    return ai.choices?.[0]?.message?.content?.trim() || "Not mentioned in the listing.";
  } catch (err) {
    log("error", "❌ aiReasonFromSources error", { error: err.message });
    return "Sorry—something went wrong while checking the listing.";
  }
}

// --- Routes ---
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

// --- Manual trigger (fixed freshness check) ---
app.post("/init/fetch", async (req, res) => {
  try {
    const { property, url } = req.body;
    if (!property || !url) return res.status(400).json({ error: "Need property + url" });

    const slug = slugify(property);
    const existing = await getPropertyFactsBySlug(slug);
    if (existing && isRecent(existing)) {
      log("info", "🕒 BrowseAI skipped: recent scrape exists", { slug });
      return res.json({ ok: true, slug, skipped: true });
    }

    await mapUrlToSlug(url, slug);
    const task = await triggerBrowseAITask(url);
    res.json({ ok: true, slug, taskId: task?.id || task?.data?.id || null });
  } catch (e) {
    log("error", "❌ /init/fetch error", { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// --- Test ---
app.post("/browseai/test", async (req, res) => {
  log("info", "✅ Test webhook hit", { body: req.body });
  res.json({ ok: true, received: req.body || "no body" });
});

// --- BrowseAI webhook ---
app.post("/browseai/webhook", async (req, res) => {
  try {
    if (BROWSEAI_WEBHOOK_SECRET) {
      const sig = req.headers["x-browseai-secret"];
      if (sig !== BROWSEAI_WEBHOOK_SECRET) return res.status(401).send("unauthorized");
    }
    const payload = req.body || {};
    log("info", "📦 [Webhook] BrowseAI data received");

    const originUrl =
      payload?.inputParameters?.["Origin URL"] ||
      payload?.task?.inputParameters?.originUrl ||
      payload?.results?.["Origin URL"] ||
      payload?.input?.startUrls?.[0] || null;

    let slug = originUrl ? await getSlugByUrl(originUrl) : null;
    if (!slug && originUrl) {
      try {
        const u = new URL(originUrl);
        slug = slugify(u.pathname.split("/").pop());
      } catch {}
    }
    if (!slug) {
      const nameGuess = payload?.results?.address || payload?.results?.Summary || payload?.results?.Title || "unknown-property";
      slug = slugify(String(nameGuess));
    }

    const task = payload.task || {};
    const captured = task.capturedTexts || payload.capturedTexts || {};
    const results = payload.results || payload.data || {};

    const normalizedFacts = {
      address: cleanText(
        (captured["Property Details"] || "").split("\n")[0].trim() ||
        (captured["Summary"] || "").split("\n")[0].trim() ||
        results.address || ""
      ),
      rent: cleanText(captured["Title Summary"] || results.rent),
      floorPlan: cleanText(captured["Available Floor Plan Options"]),
      parking: cleanText(captured["Parking Information"]),
      utilities: cleanText(captured["Utility Information"]),
      details: cleanText(captured["Property Details"]),
      summary: cleanText(captured["Summary"]),
    };

    const existingFacts = (await getPropertyFactsBySlug(slug)) || {};
    const mergedFacts = {
      ...existingFacts,
      ...results,
      ...normalizedFacts,
      listingUrl: originUrl || existingFacts.listingUrl || null,
      updatedAt: nowIso(),
      source: "browseai",
    };

    await setPropertyFactsBySlug(slug, mergedFacts);
    await redis.set(`facts:${slug}`, JSON.stringify(mergedFacts));
    if (mergedFacts.listingUrl) await mapUrlToSlug(mergedFacts.listingUrl, slug);

    res.json({ ok: true, slug, saved: Object.keys(mergedFacts).length });
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
  res.type("text/xml").send("<Response></Response>");
  try {
    let slug = await getLastPropertyForPhone(from);
    if (!slug) {
      const props = await getPropertiesForPhone(from);
      slug = props && props[0];
    }
    if (!slug) {
      await twilioClient.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to: from,
        body: "Hey! Can you send me the property link or address so I can pull up the details?",
      });
      return;
    }

    const facts = await getPropertyFactsBySlug(slug);
    const url = facts?.listingUrl || null;
    let html = await getCachedHtmlForProperty(slug);
    if (url && !html) {
      const t = timeStart("directFetch");
      const fresh = await fetchListingHTML(url, slug);
      timeEnd(t, { bytes: fresh?.length || 0 });
      html = fresh;
    }

    const answer = await aiReasonFromSources({ question: body, facts, html, url });
    await twilioClient.messages.create({ from: TWILIO_PHONE_NUMBER, to: from, body: answer });
    log("info", "✅ SMS reply sent", { to: from, slug });
  } catch (err) {
    log("error", "❌ SMS send error", { error: err.message });
  }
});

// --- Voice ---
app.post("/twiml/voice", (req, res) => {
  const twiml = `<Response>
    <Connect><Stream url="wss://${new URL(PUBLIC_BASE_URL).host}/twilio-media" /></Connect>
    <Say voice="Polly.Joanna">Hi, connecting you to the rental assistant now.</Say>
  </Response>`;
  res.type("text/xml").send(twiml);
});

// --- Debug + WebSocket ---
app.get("/debug/facts", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  const slug = slugify(req.query.property || "");
  const facts = await getPropertyFactsBySlug(slug);
  res.json({ slug, facts });
});
app.get("/debug/html", async (req,
