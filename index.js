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
const DEBUG_SECRET = process.env.DEBUG_SECRET || "changeme123"; // optional access key

// --- Initialize clients ---
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const redis = new Redis(REDIS_URL, {
  tls: false,
  connectTimeout: 5000,
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => {
    const delay = Math.min(times * 500, 5000);
    console.log(`♻️ Reconnecting to Redis in ${delay}ms...`);
    return delay;
  },
});

redis.on("connect", () => console.log("✅ Connected to Redis successfully"));
redis.on("error", (err) => console.error("❌ Redis connection error:", err.message));

// --- Helpers for conversation persistence ---
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

// --- Debug endpoint (view stored memory safely) ---
app.get("/debug/memory", async (req, res) => {
  // security key required: /debug/memory?key=yoursecret
  if (req.query.key !== DEBUG_SECRET) {
    return res.status(401).send("Unauthorized");
  }

  try {
    const keys = await redis.keys("conv:*");
    const data = {};
    for (const key of keys) {
      data[key] = JSON.parse(await redis.get(key));
    }
    res.json({ keys, data });
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

// --- SMS webhook with Redis memory ---
app.post("/twiml/sms", express.urlencoded({ extended: false }), async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim() || "";
  console.log(`📩 SMS from ${from}: ${body}`);
  res.type("text/xml");
  res.send("<Response></Response>"); // acknowledge immediately

  try {
    // Load existing conversation
    const prev = await getConversation(from);
    prev.push({ role: "user", content: body });

    // Simulate a human typing delay (2–5 seconds)
    const delayMs = 2000 + Math.random() * 3000;
    setTimeout(async () => {
      try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content:
                  "You are a friendly rental assistant. Reply like a human, warm and brief. Remember user details like name, move-in date, and property info.",
              },
              ...prev,
            ],
            max_tokens: 200,
          }),
        });

        const data = await response.json();
        const reply =
          data.choices?.[0]?.message?.content?.trim() ||
          "Hmm, can you say that again?";

        console.log("💬 GPT reply:", reply);

        prev.push({ role: "assistant", content: reply });
        await saveConversation(from, prev);

        await twilioClient.messages.create({
          from: TWILIO_PHONE_NUMBER,
          to: from,
          body: reply,
        });

        console.log(`✅ Sent reply to ${from}`);
      } catch (err) {
        console.error("❌ SMS error:", err);
      }
    }, delayMs);
  } catch (err) {
    console.error("❌ Conversation handling error:", err);
  }
});

// --- HTTP + WebSocket setup ---
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio-media") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  console.log("🔊 Twilio media stream connected!");
  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === "start") {
        console.log("🎬 Stream started:", data.streamSid);
      } else if (data.event === "stop") {
        console.log("🛑 Stream stopped:", data.streamSid);
      }
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
