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
  return (s || "unknown").replace(/\s+/g, "-").replace(/[^\w\-]/g, "").toLowerCase();
}

function extractPropertyFromText(text) {
  if (!text) return null;
  // Heuristic for addresses / “about 215 16 Street SE”
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
function nextLocal930(afterMillis) {
  const after = DateTime.fromMillis(afterMillis, { zone: LOCAL_TZ });
  let target = after.set({ hour: 9, minute: 30, second: 0, millisecond: 0 });
  if (target <= after) target = target.plus({ days: 1 });
  return target.toMillis();
}

// Topic detection for sensitive facts
function detectTopics(text) {
  const t = (text || "").toLowerCase();
  return {
    parking: /\bparking|garage|stall|park\b/.test(t),
    pets: /\bpet|pets|cat|dog\b/.test(t),
    utilities: /\butilit|power|gas|water|heat\b/.test(t),
    furnished: /\bfurnish\b/.test(t),
    price: /\bprice|rent|cost\b/.test(t),
    availability: /\bavailable|move in|move-in|start date|from\b/.test(t),
    laundry: /\blaundry|washer|dryer\b/.test(t),
    sqft: /\bsq ?ft|square feet\b/.test(t),
  };
}

// Compose a safe, human reply without inventing facts
function composeSafeReply({ firstTime, property, facts, topics }) {
  const parts = [];
  const intro = firstTime
    ? (property
        ? `Hey! I got your message about ${property}.`
        : `Hey! Thanks for reaching out.`)
    : null;
  if (intro) parts.push(intro);

  // Parking
  if (topics.parking) {
    if (facts.parking || facts.parkingFee) {
      const fee = facts.parkingFee ? ` (${facts.parkingFee})` : "";
      parts.push(`Parking: ${facts.parking || "details available"}${fee}.`);
    } else {
      parts.push(`Parking details aren’t listed — I can check for you. Do you need a spot?`);
    }
  }

  // Pets
  if (topics.pets) {
    if (typeof facts.pets === "string") {
      parts.push(`Pet policy: ${facts.pets}.`);
    } else {
      parts.push(`Pet policy isn’t listed — are you hoping to bring a pet (type/size)? I can confirm.`);
    }
  }

  // Utilities
  if (topics.utilities) {
    if (facts.utilities) {
      parts.push(`Utilities: ${facts.utilities}.`);
    } else {
      parts.push(`Utilities aren’t listed — I can check what’s included.`);
    }
  }

  // Furnished
  if (topics.furnished) {
    if (facts.furnished != null) {
      parts.push(facts.furnished ? `It’s furnished.` : `It’s unfurnished.`);
    } else {
      parts.push(`Furnishing isn’t listed — I can verify that for you.`);
    }
  }

  // Laundry
  if (topics.laundry) {
    if (facts.laundry) {
      parts.push(`Laundry: ${facts.laundry}.`);
    } else {
      parts.push(`Laundry details aren’t listed — I can check if it’s in-suite or on-site.`);
    }
  }

  // Price
  if (topics.price) {
    if (facts.price) {
      parts.push(`Rent is ${facts.price}.`);
    } else {
      parts.push(`Rent isn’t listed here — I can confirm the current price.`);
    }
  }

  // Availability
  if (topics.availability) {
    if (facts.availability) {
      parts.push(`Availability: ${facts.availability}.`);
    } else {
      parts.push(`Availability isn’t listed — I can check the earliest move-in date.`);
    }
  }

  // If nothing specific asked, suggest next step
  if (parts.length === (intro ? 1 : 0)) {
    parts.push(`Want to pick a time for a quick showing, or do you have any questions I can check on?`);
  }

  // Keep under ~3 sentences
  return parts.join(" ");
}

// --- Health check ---
app.get("/", (req, res) => {
  res.send("✅ AI Rental Assistant is running with multi-property memory, facts, follow-ups, and anti-fabrication");
});

// --- Lead registration (Zapier → here) ---
// JSON: { phone, name, propertyAddress, unit, price, bedrooms, bathrooms, availability, notes, parking, parkingFee, pets, utilities, furnished, sqft, laundry }
app.post("/lead", async (req, res) => {
  try {
    const {
      phone, name, propertyAddress, unit, price, bedrooms, bathrooms, availability, notes,
      parking, parkingFee, pets, utilities, furnished, sqft, laundry,
    } = req.body || {};
    if (!phone || !propertyAddress) return res.status(400).json({ error: "phone and propertyAddress are required" });

    const facts = {
      name, unit, price, bedrooms, bathrooms, availability, notes,
      parking, parkingFee, pets, utilities, furnished, sqft, laundry,
      propertyAddress,
    };
    await setPropertyFacts(phone, propertyAddress, facts);

    const slug = slugifyProperty(propertyAddress);
    await redis.sadd(renterSetKey(phone), slug);

    // Seed system line
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

// --- SMS webhook (hybrid: safe composer + LLM fallback, follow-up scheduling) ---
app.post("/twiml/sms", express.urlencoded({ extended: false }), async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || "").trim();
  console.log(`📩 SMS from ${from}: ${body}`);
  res.type("text/xml");
  res.send("<Response></Response>");

  try {
    // Determine property
    let property = extractPropertyFromText(body);
    if (!property) {
      const lastMetaKey = (await redis.keys(`meta:${from}:*`)).sort().pop();
      if (lastMetaKey) {
        const m = await redis.get(lastMetaKey);
        const parsed = m ? JSON.parse(m) : null;
        if (parsed && parsed.property) property = parsed.property;
      }
    }

    // Keys & facts
    const ckey = await getConvKey(from, property);
    const prev = await getConversationByKey(ckey);
    const facts = await getPropertyFacts(from, property);

    const topics = detectTopics(body);
    const firstTime = prev.length === 0;

    // Try safe composer first for sensitive topics
    let reply = composeSafeReply({ firstTime, property, facts, topics });

    // If the user didn’t ask any specific sensitive thing and it’s not first message,
    // use LLM for natural conversational replies — with strict “don’t invent” rules.
    const askedSensitive =
      topics.parking || topics.pets || topics.utilities || topics.furnished || topics.laundry || topics.price || topics.availability;

    if (!firstTime && !askedSensitive) {
      const style = STYLES[Math.floor(Math.random() * STYLES.length)];
      const propertyLine = property
        ? `You are helping a renter who inquired about the property at ${property}.`
        : `You are helping a renter asking about a property.`;
      const factLine = facts && (facts.price || facts.bedrooms || facts.bathrooms || facts.unit || facts.availability)
        ? `Facts you may reference: ${[
            facts.unit ? `${facts.unit}` : null,
            facts.bedrooms ? `${facts.bedrooms}-bed` : null,
            facts.bathrooms ? `${facts.bathrooms}-bath` : null,
            facts.price ? `listed at ${facts.price}` : null,
            facts.availability ? `availability: ${facts.availability}` : null,
            facts.parking ? `parking: ${facts.parking}` : null,
            facts.pets ? `pets: ${facts.pets}` : null,
            facts.utilities ? `utilities: ${facts.utilities}` : null,
            facts.furnished != null ? (facts.furnished ? "furnished" : "unfurnished") : null,
          ].filter(Boolean).join(", ")}.`
        : `Only reference facts explicitly listed below.`;

      const systemPrompt = {
        role: "system",
        content: `
You are an AI rental assistant named Alex.
${propertyLine}
${factLine}
CRITICAL RULES (do not break):
- Do NOT invent fees, policies, numbers, or availability.
- If a detail isn't in the facts or user message, say you’re not sure and offer to confirm.
- Keep replies under ~3 sentences, SMS-friendly, human and natural in a ${style} tone.
- If user asks to schedule, offer 2–3 concrete windows; otherwise ask their preferred time.`,
      };

      const messages = [systemPrompt, ...prev, { role: "user", content: body }];

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
      const aiText = aiData?.choices?.[0]?.message?.content?.trim();

      // Very light safety filter: if AI mentioned parking/pets/utils but we have no facts, fall back to safe composer
      const mentionsParking = /park/i.test(aiText || "");
      const mentionsPets = /\bpet|cat|dog\b/i.test(aiText || "");
      const mentionsUtils = /utilit|power|gas|water|heat/i.test(aiText || "");
      const unsafeParking = mentionsParking && !(facts.parking || facts.parkingFee);
      const unsafePets = mentionsPets && !facts.pets;
      const unsafeUtils = mentionsUtils && !facts.utilities;

      if (aiText && !(unsafeParking || unsafePets || unsafeUtils)) {
        reply = aiText;
      }
    }

    // Save conversation
    const updated = [
      ...prev,
      { role: "user", content: body },
      { role: "assistant", content: reply },
    ];
    if (property && !updated.find(m => m.role === "system" && m.content.includes("Property:"))) {
      updated.unshift({ role: "system", content: `Property: ${property}` });
    }
    await saveConversationByKey(ckey, updated);

    // Meta & follow-up scheduling
    const now = Date.now();
    const closed = messageClosesThread(body);
    const deferred = messageDefers(body);
    let status = closed ? "closed" : "open";
    let nextFollowupAt = null;

    if (!closed) {
      // schedule next-day 9:30 if the renter deferred or it's the first touch (we'll confirm at cron)
      if (deferred || firstTime) {
        nextFollowupAt = nextLocal930(now);
      }
    }

    await setMeta(from, property, {
      phone: from,
      property: property || "unknown",
      lastTs: now,
      lastSpeaker: "assistant",
      status,
      lastUserMsg: now, // updated on inbound
      nextFollowupAt,
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

// --- CRON: follow-ups (call from Render Cron) ---
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

      const { phone, property, nextFollowupAt } = meta;
      if (!phone) continue;

      const now = DateTime.now().setZone(LOCAL_TZ).toMillis();
      if (nextFollowupAt && now >= nextFollowupAt) {
        const ckey = await getConvKey(phone, property);
        const conv = await getConversationByKey(ckey);

        // Only nudge if last message is from assistant (user ghosted) OR user had deferred earlier
        const last = conv.slice(-1)[0];
        const lastTwo = conv.slice(-2);
        const renterNeverReplied = !last || last.role === "assistant";
        const deferLikely = true; // we set this when scheduling

        if (renterNeverReplied || deferLikely) {
          const facts = await getPropertyFacts(phone, property);
          const factHint = facts?.unit || facts?.price ? ` (${[facts.unit, facts.price].filter(Boolean).join(", ")})` : "";
          const nudge = property
            ? `Hey, just checking in about ${property}${factHint}. Want to pick a time for a quick showing?`
            : `Hey, just checking in about the place. Want to pick a time for a quick showing?`;

          await twilioClient.messages.create({
            from: TWILIO_PHONE_NUMBER,
            to: phone,
            body: nudge,
          });
          sent++;

          // prevent repeat the same day
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
