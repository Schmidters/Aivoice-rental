// --- Imports & setup ---
require("dotenv").config();
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const { urlencoded } = require("express");
const twilio = require("twilio");
const Redis = require("ioredis");
const { DateTime } = require("luxon");

// --- App setup ---
const app = express();
app.use(urlencoded({ extended: false }));
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
const LOCAL_TZ = "America/Edmonton";

// --- Clients ---
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const redis = new Redis(REDIS_URL, {
  tls: false,
  connectTimeout: 5000,
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 500, 5000),
});
redis.on("connect", () => console.log("✅ Connected to Redis successfully"));
redis.on("error", (err) => console.error("❌ Redis connection error:", err.message));

// --- Helpers (keys, utils) ---
const STYLES = [
  "friendly and upbeat",
  "casual and chill",
  "helpful and polite",
  "enthusiastic and professional",
];

function slugifyProperty(s) {
  return (s || "unknown")
    .replace(/\s+/g, "-")
    .replace(/[^\w\-]/g, "")
    .toLowerCase();
}

function extractPropertyFromText(text) {
  if (!text) return null;
  // Simple heuristic for street-ish mentions. Adjust as needed.
  const rx = /(for|about|regarding|re|re:|at)\s+([0-9A-Za-z][0-9A-Za-z\s\-]*(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Court|Ct|Place|Pl|SE|SW|NW|NE)?)/i;
  const m = text.match(rx);
  return m ? m[2].trim() : null;
}

async function getConvKey(phone, property) {
  const slug = slugifyProperty(property || "unknown");
  return `conv:${phone}:${slug}`;
}
function metaKey(phone, property) {
  const slug = slugifyProperty(property || "unknown");
  return `meta:${phone}:${slug}`;
}
function propFactsKey(phone, property) {
  const slug = slugifyProperty(property || "unknown");
  return `prop:${phone}:${slug}`;
}
function renterSetKey(phone) {
  return `renter:${phone}:properties`;
}

async function getConversationByKey(key) {
  const data = await redis.get(key);
  return data ? JSON.parse(data) : [];
}
async function saveConversationByKey(key, messages) {
  const trimmed = messages.slice(-12);
  await redis.set(key, JSON.stringify(trimmed));
}
async function setMeta(phone, property, patch) {
  const k = metaKey(phone, property);
  const existing = await redis.get(k);
  const obj = existing ? JSON.parse(existing) : {};
  const updated = { ...obj, ...patch };
  await redis.set(k, JSON.stringify(updated));
  return updated;
}
async function getMeta(phone, property) {
  const k = metaKey(phone, property);
  const data = await redis.get(k);
  return data ? JSON.parse(data) : null;
}
async function getPropertyFacts(phone, property) {
  const k = propFactsKey(phone, property);
  const data = await redis.get(k);
  return data ? JSON.parse(data) : {};
}
async function setPropertyFacts(phone, property, factsObj) {
  const k = propFactsKey(phone, property);
  await redis.set(k, JSON.stringify(factsObj || {}));
}

// Heuristics to decide closure / postpone
function messageClosesThread(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes("not interested") ||
    t.includes("no longer interested") ||
    t.includes("found a place") ||
    t.includes("stop") ||
    t.includes("do not contact")
  );
}
function messageDefers(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes("i'll get back") ||
    t.includes("ill get back") ||
    t.includes("get back later") ||
    t.includes("later") ||
    t.includes("circle back") ||
    t.includes("touch base later")
  );
}

// Schedules: compute the next 9:30 AM in America/Edmonton after a given time
function nextLocal930(afterMillis) {
  const after = DateTime.fromMillis(afterMillis, { zone: LOCAL_TZ });
  let target = after.set({ hour: 9, minute: 30, second: 0, millisecond: 0 });
  if (target <= after) target = target.plus({ days: 1 }); // next day 9:30
  return target.toMillis();
}

// --- Health check ---
app.get("/", (req, res) => {
  res.send("✅ AI Rental Assistant is running with multi-property memory, facts, and follow-ups");
});

// --- Lead registration (Zapier → here) ---
// Send JSON: { phone, name, propertyAddress, unit, price, bedrooms, bathrooms, availability, notes }
app.post("/lead", async (req, res) => {
  try {
    const { phone, name, propertyAddress, unit, price, bedrooms, bathrooms, availability, notes } = req.body || {};
    if (!phone || !propertyAddress) return res.status(400).json({ error: "phone and propertyAddress are required" });

    const facts = { name, unit, price, bedrooms, bathrooms, availability, notes, propertyAddress };
    await setPropertyFacts(phone, propertyAddress, facts);

    // Track directory
    const slug = slugifyProperty(propertyAddress);
    await redis.sadd(renterSetKey(phone), slug);

    // Seed a system memory line for smoother first reply
    const key = await getConvKey(phone, propertyAddress);
    const prev = await getConversationByKey(key);
    if (!prev.find(m => m.role === "system" && m.content.includes("Property:"))) {
      prev.unshift({ role: "system", content: `Property: ${propertyAddress}` });
      await saveConversationByKey(key, prev);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /lead error:", err);
    res.status(500).json({ error: "server" });
  }
});

// --- Debug: memory dump ---
app.get("/debug/memory", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  try {
    const keys = await redis.keys("conv:*");
    const data = {};
    for (const key of keys) data[key] = JSON.parse(await redis.get(key));
    res.json({ keys, data });
  } catch (err) {
    res.status(500).send(`❌ Redis error: ${err.message}`);
  }
});

// --- Debug: clear ---
app.get("/debug/clear", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  try {
    const { phone, property } = req.query;
    if (phone && property) {
      const ckey = await getConvKey(phone, property);
      const mkey = metaKey(phone, property);
      const pkey = propFactsKey(phone, property);
      await redis.del(ckey, mkey, pkey);
      return res.send(`🗑️ Cleared memory for ${phone} @ ${property}`);
    }
    if (phone) {
      const keys = await redis.keys(`conv:${phone}:*`);
      const mk = await redis.keys(`meta:${phone}:*`);
      const pk = await redis.keys(`prop:${phone}:*`);
      const all = keys.concat(mk, pk);
      if (all.length) await redis.del(all);
      return res.send(`🧹 Cleared ${all.length} keys for ${phone}`);
    }
    const keys = await redis.keys("conv:*");
    const mk = await redis.keys("meta:*");
    const pk = await redis.keys("prop:*");
    const all = keys.concat(mk, pk);
    if (all.length) await redis.del(all);
    res.send(`🧨 Cleared ALL (${all.length}) keys`);
  } catch (err) {
    res.status(500).send(`❌ Redis error: ${err.message}`);
  }
});

// --- Voice webhook (kept for completeness) ---
app.post("/twiml/voice", (req, res) => {
  const twiml = `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://aivoice-rental.onrender.com/twilio-media" />
  </Connect>
  <Say voice="Polly.Joanna">Hi, connecting you to the rental assistant now.</Say>
</Response>`.trim();
  res.set("Content-Type", "text/xml");
  res.send(twiml);
});

// --- SMS webhook (two-way AI + multi-property + follow-up scheduling) ---
app.post("/twiml/sms", express.urlencoded({ extended: false }), async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || "").trim();
  console.log(`📩 SMS from ${from}: ${body}`);
  res.type("text/xml");
  res.send("<Response></Response>");

  try {
    // Determine property context
    let property = extractPropertyFromText(body);
    // If not found, try to reuse the most recently used property meta for this renter
    if (!property) {
      const lastMetaKey = (await redis.keys(`meta:${from}:*`)).sort().pop();
      if (lastMetaKey) {
        const m = await redis.get(lastMetaKey);
        const parsed = m ? JSON.parse(m) : null;
        if (parsed && parsed.property) property = parsed.property;
      }
    }

    // Build keys and track directory
    const ckey = await getConvKey(from, property);
    const mkey = metaKey(from, property);
    const pkey = propFactsKey(from, property);
    const propSlug = slugifyProperty(property || "unknown");
    await redis.sadd(renterSetKey(from), propSlug);

    // Load memory and facts
    const prev = await getConversationByKey(ckey);
    const facts = await getPropertyFacts(from, property);

    // Style + system prompt
    const style = STYLES[Math.floor(Math.random() * STYLES.length)];
    const propertyLine = property
      ? `You are helping a renter who inquired about the property at ${property}.`
      : `You are helping a renter asking about a property.`;
    const factLine = facts && (facts.price || facts.bedrooms || facts.bathrooms || facts.unit || facts.availability)
      ? `Facts: ${[
          facts.unit ? `${facts.unit}` : null,
          facts.bedrooms ? `${facts.bedrooms}-bed` : null,
          facts.bathrooms ? `${facts.bathrooms}-bath` : null,
          facts.price ? `listed at ${facts.price}` : null,
          facts.availability ? `availability: ${facts.availability}` : null,
        ].filter(Boolean).join(", ")}.`
      : "";

    const firstTime = prev.length === 0;
    const greeting = property
      ? `Hey! I got your message about ${property} — would you like to set up a showing, or do you have any questions?`
      : `Hey! I got your message about the place — would you like to set up a showing, or do you have any questions?`;

    const systemPrompt = {
      role: "system",
      content: `
You are an AI rental assistant named Alex.
${propertyLine}
${factLine}
Respond via SMS in a ${style} tone — warm, natural, brief (max ~3 sentences unless more detail is needed).
If this is the first message from this number for this property, start with:
"${greeting}"
Vary phrasing slightly so it feels human; avoid sounding templated.
If user signals "not interested" or "found a place", politely close the thread.
If user defers ("I'll get back later"), acknowledge and keep thread open for follow-up the next day at 9:30am local.`,
    };

    const messages = [systemPrompt, ...prev, { role: "user", content: body }];

    // OpenAI call
    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        max_tokens: 220,
      }),
    });
    const aiData = await aiResp.json();
    const reply = aiData?.choices?.[0]?.message?.content?.trim() || "Got it — could you say that again?";

    console.log("💬 GPT reply:", reply);

    // Update memory
    const updated = [
      ...prev,
      { role: "user", content: body },
      { role: "assistant", content: reply },
    ];
    if (property && !updated.find(m => m.role === "system" && m.content.includes("Property:"))) {
      updated.unshift({ role: "system", content: `Property: ${property}` });
    }
    await saveConversationByKey(ckey, updated);

    // Determine meta (status + schedule)
    const now = Date.now();
    const closed = messageClosesThread(body);
    const deferred = messageDefers(body);
    let status = closed ? "closed" : "open";
    let lastSpeaker = "assistant"; // since we just replied
    let nextFollowupAt = null;
    let lastUserMsg = now;

    if (!closed) {
      // Schedule next day 9:30am if renter deferred OR if renter stopped replying (we'll evaluate at cron time)
      // We mark a target for next 9:30 now; cron will send only if no newer user message happened.
      if (deferred || firstTime) {
        nextFollowupAt = nextLocal930(now);
      }
    }

    await setMeta(from, property, {
      phone: from,
      property: property || "unknown",
      lastTs: now,
      lastSpeaker,
      status,
      lastUserMsg,
      nextFollowupAt, // millis (local 9:30 computed in Edmonton TZ)
      lastAssistantMsg: now,
    });

    // Send via Twilio
    await twilioClient.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to: from,
      body: reply,
    });
    console.log(`✅ Sent reply to ${from}`);
  } catch (err) {
    console.error("❌ SMS processing error:", err);
  }
});

// --- CRON: follow-ups (hit this from Render Cron) ---
// Logic:
//  - Run every 15 minutes (or hourly) from Render Cron in UTC.
//  - We only send follow-ups if local time is within 9:30am +/- 10 minutes.
//  - For each open thread where the last message was from assistant or renter deferred, if no new user message since, send a friendly nudge.
app.get("/cron/followups", async (req, res) => {
  try {
    const nowLocal = DateTime.now().setZone(LOCAL_TZ);
    const minutes = nowLocal.hour * 60 + nowLocal.minute;
    const target = 9 * 60 + 30; // 9:30 AM
    if (Math.abs(minutes - target) > 10) {
      return res.json({ ok: true, skipped: true, reason: "outside 9:30 window", nowLocal: nowLocal.toISO() });
    }

    const metas = await redis.keys("meta:*");
    let sent = 0;

    for (const mk of metas) {
      const m = await redis.get(mk);
      if (!m) continue;
      const meta = JSON.parse(m);
      if (meta.status === "closed") continue;

      const { phone, property, lastUserMsg, nextFollowupAt } = meta;
      if (!phone) continue;

      // If nextFollowupAt is set and now is past it, and no new user message since scheduling
      const now = DateTime.now().setZone(LOCAL_TZ).toMillis();
      if (nextFollowupAt && now >= nextFollowupAt) {
        // Ensure we reference the correct conv key
        const ckey = await getConvKey(phone, property);
        const conv = await getConversationByKey(ckey);

        // Gentle nudge text
        const style = STYLES[Math.floor(Math.random() * STYLES.length)];
        const facts = await getPropertyFacts(phone, property);
        const factHint = facts?.unit || facts?.price ? ` (${[facts.unit, facts.price].filter(Boolean).join(", ")})` : "";
        const nudge = property
          ? `Hey, just checking in about ${property}${factHint}. Would you like to pick a time for a quick showing?`
          : `Hey, just checking in about the place. Want to pick a time for a quick showing?`;

        // Send only if last message in conversation was from assistant (renter never replied) OR renter deferred.
        const lastTwo = conv.slice(-2);
        const renterNeverReplied = lastTwo.length === 0 || lastTwo[lastTwo.length - 1]?.role === "assistant";
        const deferLikely = true; // meta was set due to defer or first time

        if (renterNeverReplied || deferLikely) {
          await twilioClient.messages.create({
            from: TWILIO_PHONE_NUMBER,
            to: phone,
            body: nudge,
          });
          sent++;

          // Clear nextFollowupAt so we don't spam; you can schedule second nudge in 48h if you want
          await setMeta(phone, property, { nextFollowupAt: null, lastAssistantMsg: Date.now() });
        }
      }
    }

    res.json({ ok: true, sent, at: nowLocal.toISO() });
  } catch (err) {
    console.error("❌ /cron/followups error:", err);
    res.status(500).json({ error: "server" });
  }
});

// --- HTTP + WebSocket setup ---
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio-media") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else socket.destroy();
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
  ws.on("close", () => console.log("❌ Twilio WS closed"));
  ws.on("error", (err) => console.error("⚠️ Twilio WS error:", err.message));
});

// --- Start server ---
server.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(`💬 SMS endpoint: POST ${PUBLIC_BASE_URL}/twiml/sms`);
  console.log(`🌐 Voice endpoint: POST ${PUBLIC_BASE_URL}/twiml/voice`);
  console.log(`⏰ Followups cron endpoint: GET ${PUBLIC_BASE_URL}/cron/followups`);
});
