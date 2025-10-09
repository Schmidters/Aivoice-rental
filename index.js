require("dotenv").config();
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const { urlencoded } = require("express");
const twilio = require("twilio");

const app = express();
app.use(urlencoded({ extended: false }));

// --- Config ---
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://aivoice-rental.onrender.com";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- In-memory SMS conversation store ---
const memory = new Map();

// --- Health Check ---
app.get("/", (req, res) => {
  res.send("✅ AI Voice + SMS Rental Assistant is running (voice debug mode)");
});

// --- Debug route for OpenAI key ---
app.get("/debug/openai", (req, res) => {
  const key = process.env.OPENAI_API_KEY || "none";
  res.send(`Current API key starts with: ${key.slice(0, 10)}...`);
});

// --- Voice Webhook (TwiML) ---
app.post("/twiml/voice", (req, res) => {
  const wsUrl = `wss://${req.headers.host}/twilio-media`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="${wsUrl}" track="inbound_audio outbound_audio"/>
  </Start>
  <Say voice="Polly.Joanna">Hi, connecting you to the rental assistant now.</Say>
</Response>`;
  res.type("text/xml");
  res.send(twiml);
});

// --- SMS Route ---
app.post("/twiml/sms", express.urlencoded({ extended: false }), async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim() || "";
  res.type("text/xml");
  res.send("<Response></Response>");
  console.log(`📩 SMS from ${from}: ${body}`);

  const history = memory.get(from) || [];
  history.push({ role: "user", content: body });

  const delay = 10000 + Math.random() * 10000;
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
                "You are a friendly, conversational rental assistant. Keep replies short, warm, and natural.",
            },
            ...history,
          ],
        }),
      });

      const data = await response.json();
      const reply =
        data.choices?.[0]?.message?.content?.trim() ||
        "Hmm, can you say that again?";

      console.log("💬 GPT Reply:", reply);
      history.push({ role: "assistant", content: reply });
      memory.set(from, history.slice(-10));

      await twilioClient.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to: from,
        body: reply,
      });
      console.log(`✅ Sent reply to ${from}`);
    } catch (err) {
      console.error("❌ SMS Error:", err);
    }
  }, delay);
});

// --- WebSocket Server Setup ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio-media" });

// 🧩 Twilio Voice Stream Debug
wss.on("connection", (ws, req) => {
  console.log("🔊 Twilio media stream connected!");

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === "start") {
        console.log("🎬 Stream started:", data.streamSid);
      } else if (data.event === "media") {
        // Each media chunk contains ~20ms μ-law audio
        console.log("🎧 Received audio chunk:", data.media.payload.length, "bytes");
      } else if (data.event === "stop") {
        console.log("🛑 Stream stopped:", data.streamSid);
      }
    } catch (err) {
      console.error("⚠️ WS message error:", err);
    }
  });

  ws.on("close", () => console.log("❌ Twilio WS closed"));
  ws.on("error", (err) => console.error("⚠️ Twilio WS error:", err.message));
});

// --- Start Server ---
server.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(`🌐 Voice endpoint: POST ${PUBLIC_BASE_URL}/twiml/voice`);
  console.log(`💬 SMS endpoint: POST ${PUBLIC_BASE_URL}/twiml/sms`);
  console.log(`🔗 WebSocket endpoint: wss://${new URL(PUBLIC_BASE_URL).host}/twilio-media`);
});
