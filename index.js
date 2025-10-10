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
const HTML_SNIPPET_LIMIT = parseInt(process.env.HTML_SNIPPET_LIMIT || "20000", 10); // 20k chars
const ASK_TTL_SEC = parseInt(process.env.ASK_TTL_SEC || "900", 10); // 15 min

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

// Conversational disambiguation memory (no numeric menus)
async function setAskContext(phone, options) {
  // options: [{ slug, label, tokens:[] }, ...]
  await redis.setex(`ask:${phone}`, ASK_TTL_SEC, JSON.stringify(options));
}
async function getAskContext(phone) {
  const raw = await redis.get(`ask:${phone}`);
  return raw ? JSON.parse(raw) : null;
}
async function clearAskContext(phone) {
  await redis.del(`ask:${phone}`);
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

// --- Debug: phone mappings ---
app.get("/debug/phone", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  const phone = normalizePhone(req.query.phone);
  if (!phone) return res.status(400).send("Missing phone");
  const props = await getPropertiesForPhone(phone);
  const last = await getLastPropertyForPhone(phone);
  const ask = await getAskContext(phone);
  res.json({ phone, properties: props, lastProperty: last, askContext: ask });
});

// --- Debug: clear state ---
app.post("/debug/clear", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  const { property, phone, clearConversations } = req.body || {};
  const ops = [];
  if (property) {
    const slug = slugify(property);
    ops.push(redis.del(`facts:prop:${slug}`));
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
// Expect: leadPhone (prospect), property (address string), finalUrl (first-party URL), rent/unit optional
app.post("/init/facts", async (req, res) => {
  try {
    let { leadPhone, phone, property, finalUrl, rent, unit } = req.body;
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

    const prospect = normalizePhone(leadPhone || phone);
    if (prospect) {
      await addPropertyForPhone(prospect, propertySlug);
      // do NOT auto-set last property here; the last one will be the most recently discussed over SMS
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

// --- Conversational property resolver ---
function buildTokensFromAddress(addr) {
  if (!addr) return [];
  const a = addr.toLowerCase();
  const parts = a.split(/[\s,]+/).filter(Boolean);
  const number = parts.find(p => /^\d{2,5}$/.test(p));
  const street = parts.find(p => /[a-z]/.test(p));
  const tokens = new Set();
  if (number) tokens.add(number);
  if (street) tokens.add(street.replace(/[^a-z0-9]/g, ""));
  // also add first 2 words as phrase token
  tokens.add(parts.slice(0, 2).join(" "));
  return Array.from(tokens).filter(Boolean);
}

async function resolvePropertyForSMS({ from, body }) {
  const bodyLc = body.toLowerCase();

  // If we asked a natural question last time, try to match their free text to an option
  const pending = await getAskContext(from);
  if (pending?.length) {
    for (const opt of pending) {
      // match by any token or by substring of label
      const matchByToken = opt.tokens.some(t => t && bodyLc.includes(String(t).toLowerCase()));
      const matchByLabel = opt.label && bodyLc.includes(opt.label.toLowerCase());
      if (matchByToken || matchByLabel) {
        await clearAskContext(from);
        await setLastPropertyForPhone(from, opt.slug);
        return { slug: opt.slug, via: "ask-followup" };
      }
    }
    // Didn't match → gently re-ask once with shorter copy
    await twilioClient.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to: from,
      body: `Got it — is this about ${pending.map(p => p.label).join(" or ")}?`,
    });
    return { slug: null, via: "ask-repeat" };
  }

  // If message itself includes an address, try to map it
  const mention = body.match(ADDRESS_REGEX)?.[0];
  const phoneProps = await getPropertiesForPhone(from);

  if (mention && phoneProps.length) {
    const mentionSlug = slugify(mention);
    // exact
    if (phoneProps.includes(mentionSlug)) {
      await setLastPropertyForPhone(from, mentionSlug);
      return { slug: mentionSlug, via: "address-exact" };
    }
    // partial: score by overlap with addresses
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

  // If last property exists, use it (sticky)
  const last = await getLastPropertyForPhone(from);
  if (last) return { slug: last, via: "lastprop" };

  // If only one property linked to this phone, use it
  if (phoneProps.length === 1) {
    await setLastPropertyForPhone(from, phoneProps[0]);
    return { slug: phoneProps[0], via: "single-for-phone" };
  }

  // If multiple: ask a natural question (no menu)
  if (phoneProps.length > 1) {
    const options = [];
    for (const s of phoneProps) {
      const facts = await getPropertyFactsBySlug(s);
      const label = facts?.address || s.replaceAll("-", " ");
      const tokens = buildTokensFromAddress(label);
      options.push({ slug: s, label, tokens });
    }
    await setAskContext(from, options);
    const readable = options.map(o => o.label).slice(0, 4); // keep it short
    await twilioClient.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to: from,
      body: `I see you asked about ${readable.slice(0, -1).join(", ")}${readable.length > 1 ? " and " + readable.slice(-1) : ""}. Which one is this about?`,
    });
    return { slug: null, via: "ask-sent" };
  }

  // No mapping yet → if only one property exists globally, use it; else ask for address
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

// --- SMS webhook (Tier-1 fetch + conversational disambiguation) ---
app.post("/twiml/sms", async (req, res) => {
  const from = normalizePhone(req.body.From);
  const body = req.body.Body?.trim() || "";
  log("info", "📩 SMS received", { from, body });
  res.type("text/xml").send("<Response></Response>");

  try {
    const { slug: propertySlug, via } = await resolvePropertyForSMS({ from, body });
    log("debug", "🔎 property resolution", { from, via, propertySlug });

    if (!propertySlug) {
      // We asked a natural question or address; wait for user reply
      return;
    }

    const prev = await getConversation(from, propertySlug);
    const facts = await getPropertyFactsBySlug(propertySlug);

    let reply = "Could you share the property link?";
    if (facts?.listingUrl && !isTracker(facts.listingUrl)) {
      const t = timeStart(`[fetch] listing HTML`);
      const html = await fetchListingHTML(facts.listingUrl);
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
    await twilioClient.messages.create({ from: TWILIO_PHONE_NUMBER, to: from, body: reply });
    log("info", "✅ SMS sent", { to: from });
    // set this as the last discussed property
    await setLastPropertyForPhone(from, propertySlug);
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
