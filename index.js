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

// Cookie jar to persist Cloudflare challenge tokens, etc.
import Tough from "tough-cookie";
import fetchCookie from "fetch-cookie";

// Wrap node-fetch with cookie support (single shared jar is fine for server-side)
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

const HTML_SNIPPET_LIMIT = parseInt(process.env.HTML_SNIPPET_LIMIT || "20000", 10); // 20k chars to LLM
const HTML_CACHE_TTL_SEC = parseInt(process.env.HTML_CACHE_TTL_SEC || "900", 10); // 15 min cache

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || "";
const BROWSERLESS_REGION = process.env.BROWSERLESS_REGION || "production-sfo"; // production-sfo/lon/ams
const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY || "";

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
      "ct.sendgrid.net","cloudflare.com","challenge.cloudflare.com",
      "bit.ly","lnkd.in","l.instagram.com","linktr.ee",
    ].some(d => h.endsWith(d));
  } catch { return true; }
}
const ADDRESS_REGEX =
  /([0-9]{2,5}\s?[A-Za-z0-9.'-]+\s?(Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Boulevard|Blvd|Lane|Ln|Court|Ct|Trail|Trl|Way|Place|Pl|SE|SW|NW|NE|Southeast|Southwest|Northeast|Northwest))/i;

// --- Redis helpers ---
// Conversations remain per phone + property
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

// Property-centric facts
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

// Phone ↔ properties mapping (multi) + sticky “last property”
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

// Conversational disambiguation (natural language, not menus)
async function setAskContext(phone, options) {
  // options: [{ slug, label, tokens:[] }, ...]
  await redis.setex(`ask:${phone}`, 900, JSON.stringify(options));
}
async function getAskContext(phone) {
  const raw = await redis.get(`ask:${phone}`);
  return raw ? JSON.parse(raw) : null;
}
async function clearAskContext(phone) {
  await redis.del(`ask:${phone}`);
}

// HTML cache helpers (store per property)
async function cacheHtmlForProperty(propertySlug, html) {
  if (!html) return;
  await redis.setex(`html:${propertySlug}`, HTML_CACHE_TTL_SEC, html);
}
async function getCachedHtmlForProperty(propertySlug) {
  return await redis.get(`html:${propertySlug}`);
}

// --- Simple/Smart page fetcher with cookie jar + headless fallbacks ---
const SIMPLE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-CA,en-US;q=0.9,en;q=0.8",
};

// direct fetch with cookie persistence
async function fetchDirectHTML(url) {
  const t = timeStart(`[fetch] direct`);
  try {
    const resp = await cookieFetch(url, { headers: SIMPLE_HEADERS, redirect: "follow" });
    const status = resp.status;
    if (!resp.ok) {
      // Log a small subset of headers to verify Cloudflare
      const server = resp.headers.get("server");
      const cfRay = resp.headers.get("cf-ray");
      const vary = resp.headers.get("vary");
      log("warn", "⚠️ direct non-OK", { status, url, server, cfRay, vary });
      timeEnd(t, { ok: false, status });
      return { html: "", status };
    }
    const html = await resp.text();
    const len = html?.length || 0;
    timeEnd(t, { ok: true, len, status });
    return { html, status };
  } catch (err) {
    timeEnd(t, { ok: false, error: err.message });
    return { html: "", status: 0 };
  }
}

// Browserless /content POST (v2 REST)
async function fetchWithBrowserless(url) {
  if (!BROWSERLESS_TOKEN) return { html: "", used: false };
  const endpoint = `https://${BROWSERLESS_REGION}.browserless.io/content?token=${encodeURIComponent(BROWSERLESS_TOKEN)}`;
  const payload = {
    url,
    waitFor: "networkidle0",
    headers: SIMPLE_HEADERS,
    actions: [
      { type: "wait", value: 1200 },
      { type: "scroll", x: 0, y: 1800 },
      { type: "wait", value: 800 },
    ],
  };
  const t = timeStart(`[fetch] browserless`);
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      log("warn", "⚠️ browserless non-OK", { status: resp.status, textLen: txt.length });
      timeEnd(t, { ok: false, status: resp.status });
      return { html: "", used: true };
    }
    const html = await resp.text();
    timeEnd(t, { ok: true, len: html.length });
    return { html, used: true };
  } catch (err) {
    timeEnd(t, { ok: false, error: err.message });
    return { html: "", used: true };
  }
}

// ScrapingBee (render_js=true)
async function fetchWithScrapingBee(url) {
  if (!SCRAPINGBEE_API_KEY) return { html: "", used: false };
  const params = new URLSearchParams({
    api_key: SCRAPINGBEE_API_KEY,
    url,
    render_js: "true",
    wait: "networkidle0",
    premium_proxy: "true",
    country_code: "CA",
  });
  const beeUrl = `https://app.scrapingbee.com/api/v1/?${params.toString()}`;
  const t = timeStart(`[fetch] scrapingbee`);
  try {
    const resp = await fetch(beeUrl, { headers: SIMPLE_HEADERS });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      log("warn", "⚠️ scrapingbee non-OK", { status: resp.status, textLen: txt.length });
      timeEnd(t, { ok: false, status: resp.status });
      return { html: "", used: true };
    }
    const html = await resp.text();
    timeEnd(t, { ok: true, len: html.length });
    return { html, used: true };
  } catch (err) {
    timeEnd(t, { ok: false, error: err.message });
    return { html: "", used: true };
  }
}

// Main smart fetcher with cache
async function fetchListingHTML(url, propertySlug) {
  // 0) cache first
  const cached = await getCachedHtmlForProperty(propertySlug);
  if (cached && cached.length >= 1200) {
    log("debug", "🗃️ [HTML cache] hit", { property: propertySlug, len: cached.length });
    return cached;
  }

  // 1) direct + cookies
  const direct = await fetchDirectHTML(url);
  const hardBlocked = [401, 403, 503].includes(direct.status);
  const tooSmall = (direct.html || "").length < 1200;
  if (!hardBlocked && !tooSmall) {
    await cacheHtmlForProperty(propertySlug, direct.html);
    return direct.html;
  }

  // 2) headless via Browserless
  const bl = await fetchWithBrowserless(url);
  if (bl.used && bl.html && bl.html.length >= 1200) {
    await cacheHtmlForProperty(propertySlug, bl.html);
    return bl.html;
  }

  // 3) ScrapingBee
  const bee = await fetchWithScrapingBee(url);
  if (bee.used && bee.html && bee.html.length >= 1200) {
    await cacheHtmlForProperty(propertySlug, bee.html);
    return bee.html;
  }

  // Give up
  log("warn", "⚠️ all fetchers failed or tiny HTML", {
    directStatus: direct.status, blTried: bl.used, beeTried: bee.used
  });
  return "";
}

// --- Reason from page HTML + known facts ---
async function aiReasonFromPage({ question, html, facts, url }) {
  try {
    const snippet = (html || "").slice(0, HTML_SNIPPET_LIMIT);
    const system = `
You are "Alex", a concise, friendly rental assistant.
You're given:
1) Known context (facts) for this property.
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

// --- Debug: get facts by property ---
app.get("/debug/facts", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  const { property } = req.query;
  if (!property) return res.status(400).send("Missing property");
  const slug = slugify(property);
  const facts = await getPropertyFactsBySlug(slug);
  res.json({ property: slug, facts });
});

// --- Debug: phone mappings & ask-context ---
app.get("/debug/phone", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  const phone = normalizePhone(req.query.phone);
  if (!phone) return res.status(400).send("Missing phone");
  const props = await getPropertiesForPhone(phone);
  const last = await getLastPropertyForPhone(phone);
  const ask = await getAskContext(phone);
  res.json({ phone, properties: props, lastProperty: last, askContext: ask });
});

// --- Debug: HTML snippet for a property ---
app.get("/debug/html", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  const slug = slugify(req.query.property || "");
  if (!slug) return res.status(400).json({ error: "Missing property" });
  const cached = await getCachedHtmlForProperty(slug);
  if (!cached) return res.status(404).json({ error: "No cached HTML" });
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(cached.slice(0, 4000)); // first 4k chars
});

// --- Debug: clear state ---
app.post("/debug/clear", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  const { property, phone, clearConversations } = req.body || {};
  const ops = [];
  if (property) {
    const slug = slugify(property);
    ops.push(redis.del(`facts:prop:${slug}`), redis.del(`html:${slug}`));
    if (clearConversations) {
      const convKeys = await redis.keys(`conv:*:${slug}`);
      const metaKeys = await redis.keys(`meta:*:${slug}`);
      if (convKeys.length) ops.push(redis.del(...convKeys));
      if (metaKeys.length) ops.push(redis.del(...metaKeys));
    }
  }
  if (phone) {
    const p = normalizePhone(phone);
    const props = await getPropertiesForPhone(p);
    if (props.length) await redis.srem(`phoneprops:${p}`, ...props);
    ops.push(redis.del(`lastprop:${p}`), redis.del(`ask:${p}`));
  }
  await Promise.all(ops);
  res.json({ ok: true });
});

// --- Initialize property facts (from Zapier) ---
// Accepts: leadPhone (prospect), property (address), finalUrl (first-party), rent/unit optional, html optional (snapshot)
app.post("/init/facts", async (req, res) => {
  try {
    let { leadPhone, phone, property, finalUrl, rent, unit, html } = req.body;
    if (!property) return res.status(400).json({ error: "Missing property" });

    const propertySlug = slugify(property);

    if (finalUrl && isTracker(finalUrl)) {
      return res.status(422).json({
        error: "Tracking/interstitial URL provided. Resolve in Zapier first.",
        got: finalUrl,
      });
    }

    const facts = {
      address: property,
      rent: rent || null,
      unit: unit || null,
      listingUrl: finalUrl || null,
      initializedAt: nowIso(),
    };

    await setPropertyFactsBySlug(propertySlug, facts);

    // Save HTML snapshot (if Zapier sent it) into cache
    if (html && typeof html === "string" && html.length > 200) {
      await cacheHtmlForProperty(propertySlug, html);
      log("info", "🗃️ [HTML cache] snapshot stored from Zap", { property: propertySlug, len: html.length });
    }

    const prospect = normalizePhone(leadPhone || phone);
    if (prospect) {
      await addPropertyForPhone(prospect, propertySlug);
      log("info", "🔗 Added phone→property link", { phone: prospect, property: propertySlug });
    }

    return res.json({
      success: true,
      property: propertySlug,
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

// --- Conversational property resolver (natural follow-ups) ---
function buildTokensFromAddress(addr) {
  if (!addr) return [];
  const a = addr.toLowerCase();
  const parts = a.split(/[\s,]+/).filter(Boolean);
  const number = parts.find(p => /^\d{2,5}$/.test(p));
  const street = parts.find(p => /[a-z]/.test(p));
  const tokens = new Set();
  if (number) tokens.add(number);
  if (street) tokens.add(street.replace(/[^a-z0-9]/g, ""));
  tokens.add(parts.slice(0, 2).join(" "));
  return Array.from(tokens).filter(Boolean);
}

async function resolvePropertyForSMS({ from, body }) {
  const bodyLc = body.toLowerCase();

  // If we asked a natural question last time, try to match their free text to an option
  const pending = await getAskContext(from);
  if (pending?.length) {
    for (const opt of pending) {
      const matchByToken = opt.tokens.some(t => t && bodyLc.includes(String(t).toLowerCase()));
      const matchByLabel = opt.label && bodyLc.includes(opt.label.toLowerCase());
      if (matchByToken || matchByLabel) {
        await clearAskContext(from);
        await setLastPropertyForPhone(from, opt.slug);
        return { slug: opt.slug, via: "ask-followup" };
      }
    }
    // Re-ask once with shorter copy
    await twilioClient.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to: from,
      body: `Got it — is this about ${pending.map(p => p.label).join(" or ")}?`,
    });
    return { slug: null, via: "ask-repeat" };
  }

  // If message includes an address, try to map it to one of phone's properties
  const mention = body.match(ADDRESS_REGEX)?.[0];
  const phoneProps = await getPropertiesForPhone(from);

  if (mention && phoneProps.length) {
    const mentionSlug = slugify(mention);
    if (phoneProps.includes(mentionSlug)) {
      await setLastPropertyForPhone(from, mentionSlug);
      return { slug: mentionSlug, via: "address-exact" };
    }
    // partial match by address overlap
    let best = null, bestScore = 0;
    for (const s of phoneProps) {
      const facts = await getPropertyFactsBySlug(s);
      const addrLc = (facts?.address || "").toLowerCase();
      const score = addrLc.includes(mention.toLowerCase()) ? mention.length : 0;
      if (score > bestScore) { best = s; bestScore = score; }
    }
    if (best) {
      await setLastPropertyForPhone(from, best);
      return { slug: best, via: "address-partial" };
    }
  }

  // Sticky last property
  const last = await getLastPropertyForPhone(from);
  if (last) return { slug: last, via: "lastprop" };

  // Single known property for this phone
  if (phoneProps.length === 1) {
    await setLastPropertyForPhone(from, phoneProps[0]);
    return { slug: phoneProps[0], via: "single-for-phone" };
  }

  // Multiple properties: ask natural follow-up (no numbers)
  if (phoneProps.length > 1) {
    const options = [];
    for (const s of phoneProps) {
      const facts = await getPropertyFactsBySlug(s);
      const label = facts?.address || s.replaceAll("-", " ");
      const tokens = buildTokensFromAddress(label);
      options.push({ slug: s, label, tokens });
    }
    await setAskContext(from, options);
    const readable = options.map(o => o.label).slice(0, 4);
    await twilioClient.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to: from,
      body: `I see you asked about ${readable.slice(0, -1).join(", ")}${readable.length > 1 ? " and " + readable.slice(-1) : ""}. Which one is this about?`,
    });
    return { slug: null, via: "ask-sent" };
  }

  // No mapping yet → if only one property globally, use it; else ask for address
  const allProps = await listAllPropertySlugs();
  if (allProps.length === 1) {
    await addPropertyForPhone(from, allProps[0]);
    await setLastPropertyForPhone(from, allProps[0]);
    return { slug: allProps[0], via: "single-global" };
  }

  await twilioClient.messages.create({
    from: TWILIO_PHONE_NUMBER,
    to: from,
    body: "Which property is this about? You can say something like “215 16 Street SE”.",
  });
  return { slug: null, via: "ask-address" };
}

// --- SMS webhook (Tier-1 smart fetch + conversational disambiguation + cache) ---
app.post("/twiml/sms", async (req, res) => {
  const from = normalizePhone(req.body.From);
  const body = req.body.Body?.trim() || "";
  log("info", "📩 SMS received", { from, body });
  res.type("text/xml").send("<Response></Response>");

  try {
    const { slug: propertySlug, via } = await resolvePropertyForSMS({ from, body });
    log("debug", "🔎 property resolution", { from, via, propertySlug });

    if (!propertySlug) {
      // We asked a natural question or asked for address; wait for user reply
      return;
    }

    const prev = await getConversation(from, propertySlug);
    const facts = await getPropertyFactsBySlug(propertySlug);

    let reply = "Could you share the property link?";
    if (facts?.listingUrl && !isTracker(facts.listingUrl)) {
      const t = timeStart(`[fetch] listing HTML`);
      const html = await fetchListingHTML(facts.listingUrl, propertySlug);
      timeEnd(t, { ok: !!html, len: html?.length || 0 });

      if (html) {
        reply = await aiReasonFromPage({ question: body, html, facts, url: facts.listingUrl });
      } else {
        // facts-only fallback
        const sys = {
          role: "system",
          content: `You are Alex, a friendly rental assistant. Known facts: ${JSON.stringify(facts)}.
If info isn't present, say "not mentioned". Keep replies under 3 sentences.`,
        };
        const msgs = [sys, ...prev, { role: "user", content: body }];
        const ai = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: msgs,
          max_tokens: 180,
          temperature: 0.3,
        });
        reply = ai.choices?.[0]?.message?.content?.trim()
          || "I couldn't load the listing—could you resend the link?";
      }
    }

    log("info", "💬 GPT reply", { reply });
    const updated = [...prev, { role: "user", content: body }, { role: "assistant", content: reply }];
    await saveConversation(from, propertySlug, updated);
    await setLastPropertyForPhone(from, propertySlug);
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
      const facts = await getPropertyFactsBySlug(property);
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

// --- WebSocket for voice streaming (unchanged) ---
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
