// --- Imports & setup ---
require("dotenv").config();
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const { urlencoded } = require("express");
const twilio = require("twilio");
const Redis = require("ioredis");

// --- App setup ---
const app = express();
app.use(urlencoded({ extended: false }));

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

// Non-TLS Redis (Starter plan safe) + retry logic
const redis = new Redis(REDIS_URL, {
  tls: false,
  connectTimeout: 5000,
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 500, 5000),
});

redis.on("connect", () => console.log("✅ Connected to Redis successfully"));
redis.on("error", (err) => console.error("❌ Redis connection error:", err.message));

// --- Helpers ---
async function getConversation(phone) {
  const data = await redis.get(`conv:${phone}`);
  return data ? JSON.parse(data) : [];
}
async function saveConversation(phone, messages) {
  const trimmed = messages.slice(-10);
  await redis.set(`conv:${phone}`, JSON.stringify(trimmed));
}

// --- Health check ---
app.get("/", (req, res) => {
  res.send("✅ AI Voice + SMS Rental Assistant with Redis memory is running");
});

// --- Debug endpoints ---
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

app.get("/debug/clear", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  try {
    const target = req.query.phone;
    if (target) {
      const deleted = await redis.del(`conv:${target}`);
      return res.send(deleted ? `🗑️ Cleared memory for ${target}` : `❌ No memory found for ${target}`);
    } else {
      const keys = await redis.keys("conv:*");
      if (keys.length === 0) return res.send("✅ No conversations to clear");
      await redis.del(keys);
      res.send(`🧹 Cleared ${keys.length} conversations`);
    }
  } catch (err) {
    res.status(500).send(`❌ Redis error: ${err.message}`);
  }
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
app.post("/twiml/sms", express.urlencoded({ extended: false }), async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim() || "";
  console.log(`📩 SMS from ${from}: ${body}`);
  res.type("text/xml");
  res.send("<Response></Response>");

  try {
    // Retrieve prior memory
    const prev = await getConversation(from);

    // Try to extract property address or name from the message if first message
    let propertyInfo = null;
    if (prev.length === 0) {
      const propertyRegex = /(for|about|regarding|at)\s+([0-9A-Za-z\s\-]+(Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|SE|SW|NW|NE))/i;
      const match = body.match(propertyRegex);
      if (match) propertyInfo = match[2].trim();
    } else {
      const sys = prev.find((m) => m.role === "system" && m.content.includes("Property:"));
      if (sys) propertyInfo = sys.content.split("Property:")[1].trim();
    }

    // Build conversational style prompt
    const styles = [
      "friendly and upbeat",
      "casual and chill",
      "helpful and polite",
      "enthusiastic and professional",
    ];
    const style = styles[Math.floor(Math.random() * styles.length)];

    const propertyLine = propertyInfo
      ? `You are helping a renter who inquired about the property at ${propertyInfo}.`
      : `You are helping a renter asking about a property.`;

    const systemPrompt = {
      role: "system",
      content: `
You are an AI rental assistant named Alex. 
${propertyLine}
Respond via SMS in a ${style} tone — sound like a friendly person texting.
Be warm, human, and conversational. Vary your phrasing slightly to feel authentic.
If it's the first message from this person, greet them and reference the property directly:
Example: "Hey! I got your message about ${propertyInfo || 'the property'} — would you like to set up a showing or have any questions?"
Keep replies under 3 sentences unless needed.`,
    };

    // Append system and conversation context
    const messages = [systemPrompt, ...prev, { role: "user", content: body }];

    // Call OpenAI
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

    // Save updated conversation
    const updated = [...prev, { role: "user", content: body }, { role: "assistant", content: reply }];
    if (propertyInfo && !updated.find((m) => m.role === "system" && m.content.includes("Property:"))) {
      updated.unshift({ role: "system", content: `Property: ${propertyInfo}` });
    }
    await saveConversation(from, updated);

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
      console.error("⚠️ WS message parse error:", err);
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
});

