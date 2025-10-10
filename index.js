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

// Caching / limits
const HTML_MAX_AGE_MIN = parseInt(process.env.HTML_MAX_AGE_MIN || "1440", 10); // 24h default
const HTML_SNIPPET_LIMIT = parseInt(process.env.HTML_SNIPPET_LIMIT || "20000", 10); // chars sent to GPT

// --- Clients ---
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const redis = new Redis(REDIS_URL, { tls: false });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- Helpers ---
function normalizePhone(phone) {
  if (!phone) return null;
  const parsed = parsePhoneNumberFromString(phone, "CA");
  return parsed && parsed.isValid() ? parsed.number : phone;
}
function slugify(str) {
  return str ? str.replace(/\s+/g, "-").replace(/[^\w\-]/g, "").toLowerCase() : "unknown";
}

// Decode SendGrid redirect URLs to actual listing URLs (double-decode safe)
function cleanListingUrl(url) {
  try {
    const m = url.match(/upn=([^&]+)/);
    if (!m) return url;
    let decoded = decodeURIComponent(m[1]);
    try { decoded = decodeURIComponent(decoded); } catch (_) {}
    const real = decoded.match(/https?:\/\/[^\s]+/);
    const clean = real ? real[0] : url;
    console.log(`🔗 [URL-Clean] ${url} → ${clean}`);
    return clean;
  } catch (err) {
    console.error("⚠️ [URL-Clean] Failed to decode:", err.message);
    return url;
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
async function getPropertyFacts(phone, property) {
  const key = `facts:${phone}:${property}`;
  const data = await redis.get(key);
  return data ? JSON.parse(data) : {};
}
async function setPropertyFacts(phone, property, facts) {
  const key = `facts:${phone}:${property}`;
  await redis.set(key, JSON.stringify(facts));
  console.log(`💾 [Redis] Updated facts for ${phone}:${property}`);
}

// HTML cache by cleaned URL
async function getCachedHTML(cleanUrl) {
  const key = `html:${cleanUrl}`;
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    const { html, fetchedAt } = JSON.parse(raw);
    return { html, fetchedAt };
  } catch {
    return null;
  }
}
async function setCachedHTML(cleanUrl, html) {
  const key = `html:${cleanUrl}`;
  const payload = { html, fetchedAt: new Date().toISOString() };
  // Store without TTL; freshness checked at read time (lets us adjust HTML_MAX_AGE_MIN without re-writes)
  await redis.set(key, JSON.stringify(payload));
  console.log(`🗃️ [Cache] Stored HTML for ${cleanUrl} (${html.length} chars)`);
}

// --- Browserless fetchers ---
async function fetchWithBrowserlessContent(cleanUrl) {
  const endpoint = `https://production-sfo.browserless.io/content?token=${BROWSERLESS_KEY}`;
  const payload = {
    url: cleanUrl,
    gotoOptions: { waitUntil: "networkidle2" },
    rejectResourceTypes: ["image", "media", "font", "stylesheet"],
    bestAttempt: true,
    waitForTimeout: 6000 // allow late JS DOM updates
  };
  return fetch(endpoint, {
    method: "POST",
    headers: { "Cache-Control": "no-cache", "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}
async function fetchWithBrowserlessUnblock(cleanUrl) {
  const endpoint = `https://production-sfo.browserless.io/unblock?token=${BROWSERLESS_KEY}`;
  const payload = { url: cleanUrl };
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

// getOrFetchListingHTML: uses cache if fresh, otherwise fetches via Browserless (/content then /unblock)
async function getOrFetchListingHTML(listingUrl) {
  if (!BROWSERLESS_KEY) {
    console.warn("⚠️ No BROWSERLESS_KEY — cannot fetch listing HTML");
    return "";
  }

  const cleanUrl = cleanListingUrl(listingUrl);
  // Check cache freshness
  const cached = await getCachedHTML(cleanUrl);
  if (cached?.html && cached.fetchedAt) {
    const ageMin = (Date.now() - new Date(cached.fetchedAt).getTime()) / 60000;
    if (ageMin <= HTML_MAX_AGE_MIN) {
      console.log(`🗃️ [Cache] Using cached HTML (${Math.round(ageMin)} min old) for ${cleanUrl}`);
      return cached.html;
    }
    console.log(`♻️ [Cache] Cached HTML stale (${Math.round(ageMin)} min); refreshing → ${cleanUrl}`);
  } else {
    console.log(`🔍 [Cache] No cached HTML, fetching → ${cleanUrl}`);
  }

  // Try /content first
  let resp = await fetchWithBrowserlessContent(cleanUrl);
  if (!resp.ok) {
    const txt = await resp.text();
    console.error("❌ [/content] failed:", resp.status, txt?.slice(0, 300));
    // Fallback to /unblock for bot-protected pages
    console.warn("⚠️ Falling back to /unblock");
    resp = await fetchWithBrowserlessUnblock(cleanUrl);
    if (!resp.ok) {
      const txt2 = await resp.text();
      console.error("❌ [/unblock] failed:", resp.status, txt2?.slice(0, 300));
      return "";
    }
  }

  const html = await resp.text();
  if (html && html.length > 0) {
    await setCachedHTML(cleanUrl, html);
  }
  return html;
}

// --- Reasoning helper: answer user question from HTML + facts ---
async function aiReasonFromPage({ question, html, facts }) {
  try {
    const snippet = (html || "").slice(0, HTML_SNIPPET_LIMIT);
    const sys = `
You are "Alex", a helpful, concise rental assistant.
You are given:
1) FULL rental page HTML (truncated to a safe length)
2) Known context for this lead (facts)

Answer the user's question using what you can read in the HTML, augmented by the facts.
- Prefer direct quotes or paraphrases from the page when available.
- If the page doesn't state it clearly, say "not mentioned" or explain uncertainty.
- Keep replies under 3 sentences and be friendly.
`.trim();

    const messages = [
      { role: "system", content: sys },
      { role: "user", content: `FACTS JSON:\n${JSON.stringify(facts)}` },
      { role: "user", content: `RENTAL PAGE HTML:\n${snippet}` },
      { role: "user", content: `QUESTION:\n${question}` }
    ];

    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 250,
      temperature: 0.3
    });

    const reply = ai.choices?.[0]?.message?.content?.trim();
    return reply || "Sorry—I couldn’t find that on the listing.";
  } catch (err) {
    console.error("❌ [aiReasonFromPage] Error:", err.message);
    return "Sorry—something went wrong reading the listing.";
  }
}

// --- Health check ---
app.get("/", (req, res) => res.send("✅ AI Rental Assistant is running"));

// --- Debug routes ---
app.get("/debug/facts", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  const { phone, property } = req.query;
  if (!phone) return res.status(400).send("Missing phone");
  const slug = property ? slugify(property) : "unknown";
  const facts = await getPropertyFacts(phone, slug);
  res.json({ phone, property: slug, facts });
});

app.get("/debug/clear", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  const { phone, property } = req.query;
  const slug = property ? slugify(property) : "unknown";
  await redis.del(`conv:${phone}:${slug}`, `facts:${phone}:${slug}`, `meta:${phone}:${slug}`);
  res.send(`🧹 Cleared data for ${phone}:${slug}`);
});

// --- Initialize property facts (from Zapier) ---
// Now warms the HTML cache (best-effort) so first SMS is fast.
app.post("/init/facts", async (req, res) => {
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
      initializedAt: new Date().toISOString()
    };

    await setPropertyFacts(phone, slug, facts);
    console.log(`💾 [Init] Facts initialized for ${phone}:${slug}`, facts);

    // Warm HTML cache (non-blocking from client's POV, but awaits here so you can verify in Zapier tests)
    let htmlCachedAt = null;
    if (listingUrl) {
      const html = await getOrFetchListingHTML(listingUrl);
      if (html) htmlCachedAt = new Date().toISOString();
    }

    res.status(200).json({
      success: true,
      message: "Initialized; HTML cache warmed if URL present.",
      data: facts,
      redisKey: `facts:${phone}:${slug}`,
      htmlCachedAt
    });
  } catch (err) {
    console.error("❌ /init/facts error:", err);
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
  const from = normalizePhone(req.body.From);
  const body = req.body.Body?.trim() || "";
  console.log(`📩 SMS from ${from}: ${body}`);
  res.type("text/xml").send("<Response></Response>");

  try {
    // Heuristic: try to infer property slug from message; default to "unknown".
    const propertyRegex =
      /([0-9]{2,5}\s?[A-Za-z]+\s?(Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|SE|SW|NW|NE|Southeast|Southwest|Northeast|Northwest))/i;
    const match = body.match(propertyRegex);
    const propertySlug = slugify(match ? match[0] : "unknown");

    const prev = await getConversation(from, propertySlug);
    const facts = await getPropertyFacts(from, propertySlug);

    // If we have a listing URL, ensure we have HTML (cache or live)
    let reply = "";
    if (facts?.listingUrl) {
      const html = await getOrFetchListingHTML(facts.listingUrl);
      if (html) {
        reply = await aiReasonFromPage({ question: body, html, facts });
      } else {
        // Fallback to known facts only
        const sys = {
          role: "system",
          content: `You are Alex, a friendly rental assistant. Known facts: ${JSON.stringify(facts)}. 
If info isn't present, say "not mentioned". Keep replies under 3 sentences.`
        };
        const msgs = [sys, ...prev, { role: "user", content: body }];
        const ai = await openai.chat.completions.create({ model: "gpt-4o-mini", messages: msgs, max_tokens: 180 });
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
      const ai = await openai.chat.completions.create({ model: "gpt-4o-mini", messages: msgs, max_tokens: 180 });
      reply = ai.choices?.[0]?.message?.content?.trim() || "Could you share the property address or link?";
    }

    console.log("💬 GPT reply:", reply);

    const updated = [...prev, { role: "user", content: body }, { role: "assistant", content: reply }];
    await saveConversation(from, propertySlug, updated);
    await twilioClient.messages.create({ from: TWILIO_PHONE_NUMBER, to: from, body: reply });
    console.log(`✅ Sent reply to ${from}`);
  } catch (err) {
    console.error("❌ SMS error:", err);
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
  console.log("🔊 Twilio media stream connected!");
  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === "start") console.log("🎬 Stream started:", data.streamSid);
      if (data.event === "stop") console.log("🛑 Stream stopped:", data.streamSid);
    } catch (err) {
      console.error("⚠️ WS parse error:", err);
    }
  });
});

// --- Start server ---
server.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(`💬 SMS endpoint: POST ${PUBLIC_BASE_URL}/twiml/sms`);
  console.log(`🌐 Voice endpoint: POST ${PUBLIC_BASE_URL}/twiml/voice`);
  console.log(`🧠 Init facts endpoint: POST ${PUBLIC_BASE_URL}/init/facts`);
});
