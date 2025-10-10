// --- Imports & setup ---
require("dotenv").config();
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const { DateTime } = require("luxon");
const twilio = require("twilio");
const Redis = require("ioredis");

// --- App setup ---
const app = express();
app.use(express.urlencoded({ extended: false }));

// --- Config ---
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://aivoice-rental.onrender.com";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const REDIS_URL = process.env.REDIS_URL;
const DEBUG_SECRET = process.env.DEBUG_SECRET || "changeme123";

// --- Clients ---
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const redis = new Redis(REDIS_URL, {
  tls: false,
  connectTimeout: 5000,
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 500, 5000),
});
redis.on("connect", () => console.log("✅ Connected to Redis successfully"));
redis.on("error", (err) => console.error("❌ Redis error:", err.message));

// --- Redis helpers ---
async function getConversation(phone, propertySlug) {
  const key = `conv:${phone}:${propertySlug}`;
  const data = await redis.get(key);
  return data ? JSON.parse(data) : [];
}
async function saveConversation(phone, propertySlug, messages) {
  const key = `conv:${phone}:${propertySlug}`;
  const metaKey = `meta:${phone}:${propertySlug}`;
  const trimmed = messages.slice(-10);

  await redis.set(key, JSON.stringify(trimmed));

  try {
    // check if metaKey is valid type
    const type = await redis.type(metaKey);
    if (type !== "hash" && type !== "none") {
      console.warn(`⚠️ Clearing invalid meta key type for ${metaKey} (${type})`);
      await redis.del(metaKey);
    }
    await redis.hset(metaKey, "lastInteraction", DateTime.now().toISO());
  } catch (err) {
    console.error("⚠️ Error updating meta:", err);
  }
}

// --- AI Context Fetcher ---
async function fetchAndExtractFact(url, topic) {
  try {
    if (!url) return null;
    const prompt = `
You are an assistant that extracts property facts from a rental listing web page.
Given the page at ${url}, find the ${topic} information if present.
Reply briefly (one sentence or less). If not mentioned, reply "not mentioned".
Do NOT make assumptions or fabricate details.
    `.trim();

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "input_text", text: url },
            ],
          },
        ],
      }),
    });

    const data = await resp.json();
    const output = data.output_text?.trim() || null;
    console.log(`🔍 Extracted ${topic} from ${url}: ${output}`);
    return output;
  } catch (err) {
    console.error("⚠️ fetchAndExtractFact error:", err);
    return null;
  }
}

// --- Utility: Normalize property into slug ---
function slugify(str) {
  return str
    ? str.replace(/\s+/g, "-").replace(/[^\w\-]/g, "").toLowerCase()
    : "unknown";
}

// --- Health check ---
app.get("/", (req, res) => {
  res.send("✅ AI Voice + SMS Rental Assistant with Smart Context Fetcher running");
});

// --- Debug endpoints ---
app.get("/debug/memory", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  const keys = await redis.keys("conv:*");
  const data = {};
  for (const key of keys) data[key] = JSON.parse(await redis.get(key));
  res.json({ keys, data });
});
app.get("/debug/clear", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  const { phone, property } = req.query;
  const slug = property ? slugify(property) : null;
  if (phone && slug) {
    await redis.del(`conv:${phone}:${slug}`, `facts:${phone}:${slug}`);
    return res.send(`🧹 Cleared conversation and facts for ${phone} (${slug})`);
  }
  if (phone) {
    const keys = await redis.keys(`conv:${phone}:*`);
    for (const k of keys) await redis.del(k);
    return res.send(`🧹 Cleared all conversations for ${phone}`);
  }
  const allKeys = await redis.keys("conv:*");
  if (!allKeys.length) return res.send("No conversations to clear");
  await redis.del(allKeys);
  res.send(`🧹 Cleared ${allKeys.length} conversations`);
});

// --- Voice webhook (for completeness) ---
app.post("/twiml/voice", (req, res) => {
  const twiml = `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://aivoice-rental.onrender.com/twilio-media" />
  </Connect>
  <Say voice="Polly.Joanna">Hi, connecting you to the rental assistant now.</Say>
</Response>
  `.trim();
  res.set("Content-Type", "text/xml");
  res.send(twiml);
});

// --- SMS webhook ---
app.post("/twiml/sms", async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim() || "";
  console.log(`📩 SMS from ${from}: ${body}`);
  res.type("text/xml").send("<Response></Response>");

  try {
    // Determine property
    let propertyInfo = null;
    const propertyRegex = /(for|about|regarding|at)\s+([0-9A-Za-z\s\-]+(Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|SE|SW|NW|NE))/i;
    const match = body.match(propertyRegex);
    if (match) propertyInfo = match[2].trim();

    const propertySlug = slugify(propertyInfo || "unknown");

    // Load existing data
    const prev = await getConversation(from, propertySlug);
    const facts = await getPropertyFacts(from, propertySlug);

    // Check for enrichable topics
    const topics = {
      parking: /\bparking\b/i.test(body),
      pets: /\b(pet|dog|cat)\b/i.test(body),
      utilities: /\b(utilit|electric|gas|heat|water)\b/i.test(body),
    };

    // Auto-fetch missing facts
    const enrichableTopics = Object.entries(topics).filter(([k, v]) => v);
    for (const [topic, asked] of enrichableTopics) {
      if (asked && !facts[topic] && facts.listingUrl) {
        const fetched = await fetchAndExtractFact(facts.listingUrl, topic);
        if (fetched && fetched !== "not mentioned") {
          facts[topic] = fetched;
          await setPropertyFacts(from, propertySlug, facts);
        }
      }
    }

    // --- Compose human message ---
    const styles = ["friendly and upbeat", "casual and chill", "helpful and polite", "enthusiastic and professional"];
    const style = styles[Math.floor(Math.random() * styles.length)];
    const propertyLine = propertyInfo
      ? `You are helping a renter who inquired about ${propertyInfo}.`
      : `You are helping a renter asking about a property.`;

    const systemPrompt = {
      role: "system",
      content: `
You are an AI rental assistant named Alex.
${propertyLine}
Known facts: ${JSON.stringify(facts)}.
Respond in a ${style} tone — sound like a friendly human via SMS.
If it's the first message, greet them and reference the property directly.
If info is unknown, say "I’m not sure, but I can check for you."
Keep replies under 3 sentences.`,
    };

    const messages = [systemPrompt, ...prev, { role: "user", content: body }];

    // OpenAI call
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        max_tokens: 200,
      }),
    });

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || "Hey, could you say that again?";

    console.log("💬 GPT reply:", reply);

    // Save and send
    const updated = [...prev, { role: "user", content: body }, { role: "assistant", content: reply }];
    await saveConversation(from, propertySlug, updated);

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

// --- Follow-up checker ---
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
        const [, phone, propertySlug] = key.split(":");
        followups.push({ phone, propertySlug });
      }
    }

    for (const { phone, propertySlug } of followups) {
      const facts = await getPropertyFacts(phone, propertySlug);
      const text = facts?.address
        ? `Hey, just checking if you’d like to set up a showing for ${facts.address} 😊`
        : `Hey, just checking if you’re still interested in booking a showing 😊`;

      await twilioClient.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to: phone,
        body: text,
      });

      console.log(`📆 Follow-up sent to ${phone}`);
    }

    res.send(`✅ Follow-ups sent: ${followups.length}`);
  } catch (err) {
    console.error("❌ Follow-up error:", err);
    res.status(500).send(err.message);
  }
});

// --- WebSocket handler ---
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
      console.error("⚠️ WS message parse error:", err);
    }
  });
});

// --- Start server ---
server.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(`💬 SMS endpoint: POST ${PUBLIC_BASE_URL}/twiml/sms`);
  console.log(`🌐 Voice endpoint: POST ${PUBLIC_BASE_URL}/twiml/voice`);
  console.log(`⏰ Follow-up cron: GET ${PUBLIC_BASE_URL}/cron/followups`);
});
