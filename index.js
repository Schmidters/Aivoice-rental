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

// --- In-memory conversation memory for SMS ---
const conversationMemory = new Map();

// --- Health check ---
app.get("/", (req, res) => {
  res.send("✅ AI Voice + SMS Rental Assistant is running (WebSocket fixed)");
});

// --- Debug endpoint ---
app.get("/debug/openai", (req, res) => {
  const key = process.env.OPENAI_API_KEY || "none";
  res.send(`Current API key starts with: ${key.slice(0, 10)}...`);
});

// --- Voice webhook (TwiML) ---
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


// --- SMS route (memory + human delay) ---
app.post("/twiml/sms", express.urlencoded({ extended: false }), async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim() || "";
  console.log(`📩 SMS from ${from}: ${body}`);
  res.type("text/xml");
  res.send("<Response></Response>");

  const prev = conversationMemory.get(from) || [];
  prev.push({ role: "user", content: body });

  const delayMs = 10000 + Math.random() * 10000;

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
      conversationMemory.set(from, prev.slice(-10));

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
});

// --- HTTP server ---
const server = http.createServer(app);

// --- WebSocket Upgrade handler ---
const wss = new WebSocketServer({ noServer: true });

// Handle WS upgrade manually (Render proxy-safe)
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio-media") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// --- Twilio media stream handler ---
wss.on("connection", (ws, req) => {
  console.log("🔊 Twilio media stream connected!");

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === "start") {
        console.log("🎬 Stream started:", data.streamSid);
      } else if (data.event === "media") {
        console.log("🎧 Audio chunk:", data.media.payload.length, "bytes");
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
  console.log(`🌐 Voice endpoint: POST https://aivoice-rental.onrender.com/twiml/voice`);
  console.log(`💬 SMS endpoint: POST https://aivoice-rental.onrender.com/twiml/sms`);
  console.log(`🔗 WS upgrade endpoint: wss://aivoice-rental.onrender.com/twilio-media`);
});
