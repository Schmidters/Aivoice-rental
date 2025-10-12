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

const HTML_SNIPPET_LIMIT = parseInt(process.env.HTML_SNIPPET_LIMIT || "80000", 10);
const HTML_CACHE_TTL_SEC = parseInt(process.env.HTML_CACHE_TTL_SEC || "900", 10);

// Optional fallbacks
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || "";
const BROWSERLESS_REGION = process.env.BROWSERLESS_REGION || "production-sfo";
const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY || "";

// ✅ Browse AI
const BROWSEAI_KEY = process.env.BROWSEAI_KEY || "";
const BROWSEAI_ROBOT_ID = process.env.BROWSEAI_ROBOT_ID || "";

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
function timeEnd(t, extra = {}) { const ms = Date.now() - t.t0; log("debug", `⏱️ ${t.label}`, { ms, ...extra }); }

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
      "ct.sendgrid.net", "cloudflare.com", "challenge.cloudflare.com", "bit.ly",
      "lnkd.in", "l.instagram.com", "linktr.ee",
    ].some(d => h.endsWith(d));
  } catch {
    return true;
  }
}

// Visible-content quality check so we don’t get stuck with “head-only” HTML
function isUsableListingHtml(html) {
  if (!html || html.length < 2000) return false;
  const hasBody = /<body[^>]*>[\s\S]*<\/body>/i.test(html);
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  const textLen = visible.replace(/<[^>]+>/g, "").length;
  const hasListingClues = /(bed|bath|sq\.?ft|parking|amenit|lease|pet|rent|utilities|neighbourhood|apartment|condo|suite)/.test(visible);
  const headOnly = /font awesome/i.test(html) && textLen < 1500;
  return hasBody && textLen > 3000 && hasListingClues && !headOnly;
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
async function addPropertyForPhone(phone, slug) { if (phone && slug) await redis.sadd(`phoneprops:${phone}`, slug); }
async function getPropertiesForPhone(phone) { return (await redis.smembers(`phoneprops:${phone}`)) || []; }
async function setLastPropertyForPhone(phone, slug) { await redis.set(`lastprop:${phone}`, slug); }
async function getLastPropertyForPhone(phone) { return await redis.get(`lastprop:${phone}`); }
async function cacheHtmlForProperty(slug, html) { if (html) await redis.setex(`html:${slug}`, HTML_CACHE_TTL_SEC, html); }
async function getCachedHtmlForProperty(slug) { return await redis.get(`html:${slug}`); }

// --- Fetchers ---
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
async function fetchWithBrowserless(url) {
  if (!BROWSERLESS_TOKEN) return { html: "", used: false };
  const endpoint = `https://${BROWSERLESS_REGION}.browserless.io/content?token=${encodeURIComponent(BROWSERLESS_TOKEN)}`;
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        elements: ["html"],
        waitUntil: "networkidle0",
        viewport: { width: 1280, height: 800 },
        launchOptions: { args: ["--no-sandbox", "--disable-setuid-sandbox"] },
      }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      log("warn", "⚠️ Browserless non-OK", { status: resp.status, url, err: text });
      return { html: "", used: true };
    }
    const html = await resp.text();
    return { html, used: true };
  } catch (e) {
    log("warn", "⚠️ Browserless fetch error", { url, error: e.message });
    return { html: "", used: true };
  }
}
async function fetchWithScrapingBee(url) {
  if (!SCRAPINGBEE_API_KEY) return { html: "", used: false };
  const params = new URLSearchParams({
    api_key: SCRAPINGBEE_API_KEY,
    url,
    render_js: "true",
    block_resources: "false",
    premium_proxy: "true",
    stealth_proxy: "true",
    country_code: "CA",
    wait_browser: "networkidle0",
    wait: "8000",
    js_scenario: JSON.stringify([{ wait: 5000 }, { scroll_y: 1500 }, { wait: 2000 }]),
  });
  const beeUrl = `https://app.scrapingbee.com/api/v1/?${params}`;
  try {
    const resp = await fetch(beeUrl, { headers: SIMPLE_HEADERS });
    if (!resp.ok) {
      log("warn", "⚠️ ScrapingBee non-OK", { status: resp.status, url });
      return { html: "", used: true };
    }
    const html = await resp.text();
    log("info", "🌐 [Fetch] ScrapingBee OK", { url, len: html.length });
    return { html, used: true };
  } catch (e) {
    log("warn", "⚠️ ScrapingBee fetch error", { url, error: e.message });
    return { html: "", used: true };
  }
}

// ✅ Browse AI runner (polls until finished, then returns structured data and/or html)
async function fetchWithBrowseAI(url) {
  if (!BROWSEAI_KEY || !BROWSEAI_ROBOT_ID) return { used: false, data: null, html: "" };
  try {
    // Start a run
    const startResp = await fetch(`https://api.browse.ai/v2/robots/${encodeURIComponent(BROWSEAI_ROBOT_ID)}/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BROWSEAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ startUrls: [url] }),
    });

    const startJson = await startResp.json();
    if (!startResp.ok) {
      log("warn", "⚠️ BrowseAI start non-OK", { status: startResp.status, msg: startJson?.message });
      return { used: true, data: null, html: "" };
    }

    // Run id can be on startJson.id or startJson.run?.id (be defensive)
    const runId = startJson.id || startJson.run?.id || startJson.data?.id;
    if (!runId) {
      log("warn", "⚠️ BrowseAI missing run id", { startJson });
      return { used: true, data: null, html: "" };
    }

    // Poll for completion
    const t0 = Date.now();
    const timeoutMs = 60000;
    let resultJson = null;

    while (Date.now() - t0 < timeoutMs) {
      await new Promise(r => setTimeout(r, 2500));
      const poll = await fetch(`https://api.browse.ai/v2/runs/${encodeURIComponent(runId)}`, {
        headers: { Authorization: `Bearer ${BROWSEAI_KEY}` },
      });
      const pollJson = await poll.json();
      const status = pollJson.status || pollJson.data?.status;
      if (status === "succeeded" || status === "completed") {
        resultJson = pollJson.result || pollJson.data?.result || pollJson.data;
        break;
      }
      if (status === "failed" || status === "errored" || status === "canceled") {
        log("warn", "⚠️ BrowseAI run failed", { status, runId });
        return { used: true, data: null, html: "" };
      }
    }

    if (!resultJson) {
      log("warn", "⚠️ BrowseAI timeout", { runId });
      return { used: true, data: null, html: "" };
    }

    // Normalize outputs
    const structured = resultJson.data || resultJson.items || null;
    const html = resultJson.html || "";

    log("info", "🤖 [BrowseAI] completed", { hasData: !!structured, hasHtml: !!html });
    return { used: true, data: structured, html };
  } catch (e) {
    log("error", "❌ BrowseAI error", { error: e.message });
    return { used: true, data: null, html: "" };
  }
}

// Merge new facts into existing
function mergeFacts(base = {}, incoming = {}) {
  const merged = { ...(base || {}) };
  for (const [k, v] of Object.entries(incoming || {})) {
    if (v === null || v === undefined || v === "") continue;
    merged[k] = v;
  }
  return merged;
}

// --- AI reasoning ---
async function aiReasonFromPage({ question, html, facts, url }) {
  try {
    const snippet = (html || "").slice(0, HTML_SNIPPET_LIMIT);
    const system = `You are "Alex", a concise, friendly rental assistant. Use structured FACTS first, then the HTML snippet as supporting evidence. If a detail isn't present, say so briefly.`;
    const messages = [
      { role: "system", content: system },
      { role: "user", content: `FACTS JSON:\n${JSON.stringify(facts, null, 2)}` },
      { role: "user", content: `URL:\n${url || "unknown"}` },
      { role: "user", content: `HTML SNIPPET:\n${snippet}` },
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

// --- Core: fetch listing HTML or structured facts (BrowseAI-first), cache good results
async function fetchListingAndFacts(url, slug, { force = false } = {}) {
  // 0) Try facts cache
  const existingFacts = await getPropertyFactsBySlug(slug);

  // 1) Try HTML cache
  const cached = await getCachedHtmlForProperty(slug);
  if (cached) {
    const ok = isUsableListingHtml(cached);
    log("info", "🗄️ [Cache] HIT", { slug, ok, len: cached.length, force });
    if (ok && !force) return { html: cached, facts: existingFacts };
    log("warn", "🗄️ [Cache] BYPASS (bad or forced)", { slug });
  } else {
    log("info", "🗄️ [Cache] MISS", { slug });
  }

  // 2) ✅ Browse AI (primary)
  if (BROWSEAI_KEY && BROWSEAI_ROBOT_ID) {
    const br = await fetchWithBrowseAI(url);
    if (br.used) {
      let newFacts = existingFacts;
      if (br.data) {
        // If Browse AI returns list of fields, squash into a flat bag of facts
        const flattened = Array.isArray(br.data)
          ? Object.fromEntries(
              br.data.flatMap((row, i) =>
                Object.entries(row || {}).map(([k, v]) => [k, v])
              )
            )
          : br.data;

        newFacts = mergeFacts(existingFacts, {
          ...(flattened || {}),
          listingUrl: url,
          browseAiUpdatedAt: nowIso(),
        });
        await setPropertyFactsBySlug(slug, newFacts);
        log("info", "💾 [Facts] Updated from BrowseAI", { slug, keys: Object.keys(newFacts).length });
      }

      // If BrowseAI provided HTML (some templates do), cache it
      if (br.html && isUsableListingHtml(br.html)) {
        await cacheHtmlForProperty(slug, `<!-- source:browseai -->\n${br.html}`);
        return { html: br.html, facts: newFacts };
      }

      // If we only got structured facts, synthesize lightweight HTML so the LLM still “sees” content
      if (br.data && !cached) {
        const syntheticHtml = `<!-- source:browseai+synthetic -->
          <html><body><h1>Listing Facts (BrowseAI)</h1><pre>${JSON.stringify(br.data, null, 2)}</pre></body></html>`;
        await cacheHtmlForProperty(slug, syntheticHtml);
        return { html: syntheticHtml, facts: newFacts };
      }
    }
  }

  // 3) Direct
  const direct = await fetchDirectHTML(url);
  log("info", "🌐 [Fetch] Direct", { status: direct.status, len: (direct.html || "").length });
  if ([200].includes(direct.status) && isUsableListingHtml(direct.html)) {
    await cacheHtmlForProperty(slug, `<!-- source:direct -->\n${direct.html}`);
    return { html: direct.html, facts: existingFacts };
  }

  // 4) Browserless
  const bl = await fetchWithBrowserless(url);
  log("info", "🌐 [Fetch] Browserless", { used: bl.used, len: (bl.html || "").length });
  if (bl.used && isUsableListingHtml(bl.html)) {
    await cacheHtmlForProperty(slug, `<!-- source:browserless -->\n${bl.html}`);
    return { html: bl.html, facts: existingFacts };
  }

  // 5) ScrapingBee
  const bee = await fetchWithScrapingBee(url);
  log("info", "🌐 [Fetch] ScrapingBee", { used: bee.used, len: (bee.html || "").length });
  if (bee.used && isUsableListingHtml(bee.html)) {
    await cacheHtmlForProperty(slug, `<!-- source:scrapingbee -->\n${bee.html}`);
    return { html: bee.html, facts: existingFacts };
  }

  // Last resort: return whatever best we have
  return { html: cached || direct.html || bl.html || bee.html || "", facts: existingFacts };
}

// --- Health check ---
app.get("/", (req, res) => res.send("✅ AI Rental Assistant is running"));

// --- Init facts (Zapier or any source) ---
app.post("/init/facts", async (req, res) => {
  try {
    let { leadPhone, phone, property, finalUrl, rent, unit, html } = req.body;
    if (!property) return res.status(400).json({ error: "Missing property" });
    const slug = slugify(property);
    if (finalUrl && isTracker(finalUrl))
      return res.status(422).json({ error: "Tracking/interstitial URL provided.", got: finalUrl });

    const facts = mergeFacts(await getPropertyFactsBySlug(slug), {
      address: property,
      rent: rent || null,
      unit: unit || null,
      listingUrl: finalUrl || null,
      initializedAt: nowIso(),
    });
    await setPropertyFactsBySlug(slug, facts);
    if (html && html.length > 200) await cacheHtmlForProperty(slug, html);
    const prospect = normalizePhone(leadPhone || phone);
    if (prospect) await addPropertyForPhone(prospect, slug);
    res.json({ success: true, property: slug, data: facts });
  } catch (e) {
    log("error", "❌ /init/facts error", { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// --- Warm + fetch via chain (force refresh) ---
app.post("/init/fetch-and-cache", async (req, res) => {
  try {
    const { property, url } = req.body;
    if (!property || !url) return res.status(400).json({ error: "Missing property or url" });
    const slug = slugify(property);
    const { html, facts } = await fetchListingAndFacts(url, slug, { force: true });
    res.json({ ok: true, slug, htmlLen: (html || "").length, factsKeys: Object.keys(facts || {}).length });
  } catch (e) {
    log("error", "❌ /init/fetch-and-cache error", { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// --- Twilio SMS ---
app.post("/twiml/sms", async (req, res) => {
  const from = normalizePhone(req.body.From);
  const body = (req.body.Body || "").trim();
  log("info", "📩 SMS received", { from, body });

  // Twilio requires a fast XML response; we reply via REST API after.
  res.type("text/xml").send("<Response></Response>");

  try {
    // Choose property: last used or only one attached to phone
    let slug = await getLastPropertyForPhone(from);
    if (!slug) {
      const props = await getPropertiesForPhone(from);
      slug = props?.[props.length - 1]; // pick the most recent added
    }

    let facts = slug ? await getPropertyFactsBySlug(slug) : null;

    // If we still don’t know the property, ask a friendly follow-up
    if (!slug || !facts) {
      await twilioClient.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to: from,
        body: "Hey! Which property are you asking about? (Please reply with the address or a link.)",
      });
      return;
    }

    const url = facts.listingUrl;
    let html = await getCachedHtmlForProperty(slug);

    // If cache is empty or junk, fetch via chain (BrowseAI-first)
    if (!isUsableListingHtml(html)) {
      const fetched = await fetchListingAndFacts(url, slug, { force: !html });
      html = fetched.html || html || "";
      facts = fetched.facts || facts;
    }

    // Have the AI answer using facts + HTML
    const answer = await aiReasonFromPage({
      question: body,
      html,
      facts,
      url,
    });

    await twilioClient.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to: from,
      body: answer,
    });

    await setLastPropertyForPhone(from, slug);
    log("info", "✅ SMS reply sent", { to: from, slug });
  } catch (err) {
    log("error", "❌ SMS send error", { error: err.message });
    try {
      await twilioClient.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to: from,
        body: "Sorry—I'm having trouble reading the listing right now. Could you share the link to the property?",
      });
    } catch {}
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
app.post("/debug/cache/flush", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  const slug = slugify(req.body.property || req.query.property || "");
  if (!slug) return res.status(400).json({ error: "Missing property" });
  await redis.del(`html:${slug}`);
  res.json({ ok: true, slug, flushed: true });
});
app.get("/debug/browseai", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  const slug = slugify(req.query.property || "");
  const facts = await getPropertyFactsBySlug(slug);
  res.json({ slug, browseAiKeys: Object.keys(facts || {}).filter(k => k.toLowerCase().includes("browse")) , facts });
});

// --- WebSocket (Twilio media, unchanged) ---
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio-media") wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  else socket.destroy();
});
wss.on("connection", ws => { log("info", "🔊 Twilio media stream connected!"); });

// --- Start server ---
server.listen(PORT, () => {
  log("info", "✅ Server listening", { port: PORT });
  log("info", "💬 SMS endpoint", { method: "POST", url: `${PUBLIC_BASE_URL}/twiml/sms` });
  log("info", "🌐 Voice endpoint", { method: "POST", url: `${PUBLIC_BASE_URL}/twiml/voice` });
  log("info", "🧠 Init facts endpoint", { method: "POST", url: `${PUBLIC_BASE_URL}/init/facts` });
  log("info", "🔥 Warm+cache endpoint", { method: "POST", url: `${PUBLIC_BASE_URL}/init/fetch-and-cache` });
});
