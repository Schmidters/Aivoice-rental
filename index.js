require("dotenv").config();
const express = require("express");
const { WebSocketServer } = require("ws");
const { urlencoded } = require("express");
const http = require("http");
const twilio = require("twilio");

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";
const OPENAI_REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || "verse";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://aivoice-rental.onrender.com";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const app = express();
app.use(urlencoded({ extended: false }));

// 🧠 Simple in-memory conversation storage (per phone number)
const conversationMemory = new Map();

// ✅ Debug endpoint to confirm API key
app.get("/debug/openai", (req, res) => {
  const key = process.env.OPENAI_API_KEY || "none";
  res.send(`Current API key starts with: ${key.slice(0, 10)}...`);
});

// ✅ Health check
app.get("/", (req, res) => {
  res.send("✅ AI Voice + SMS Rental Assistant is live with memory!");
});

// ✅ Voice test route
app.get("/twiml/voice", (req, res) => {
  res.type("text/xml");
  res.send(`<Response><Say>Hello! This is a test. Your Twilio connection works.</Say></Response>`);
});

// 🧠 Twilio Voice route
app.post("/twiml/voice", (req, res) => {
  const wsUrl = `wss://aivoice-rental.onrender.com/twilio-media`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="${wsUrl}" track="inbound_audio outbound_audio" />
  </Start>
  <Say voice="Polly.Joanna">Hi, connecting you to the rental assistant now.</Say>
</Response>`;
  res.type("text/xml");
  res.send(twiml);
});

// 💬 SMS route — memory-enabled
app.post("/twiml/sms", express.urlencoded({ extended: false }), async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim() || "";

  console.log(`📩 SMS from ${from}: ${body}`);
  res.type("text/xml");
  res.send("<Response></Response>"); // respond quickly so Twilio doesn’t retry

  // Get prior conversation for this user
  const previousMessages = conversationMemory.get(from) || [];

  // Add the user’s new message
  previousMessages.push({ role: "user", content: body });

  const delayMs = 10000 + Math.random() * 10000;

  setTimeout(async () => {
    try {
      console.log("➡️ Sending conversation history to OpenAI:", previousMessages);

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
                "You are a friendly, natural-sounding rental assistant for a property management company. Keep replies short, warm, and human-like. Remember details shared earlier in the conversation, like the person’s name, desired property, or timing.",
            },
            ...previousMessages,
          ],
          max_tokens: 200,
        }),
      });

      const data = await response.json();
      console.log("🧠 Full OpenAI response:", JSON.stringify(data, null, 2));

      const replyText =
        data.choices?.[0]?.message?.content?.trim() ||
        "Hmm, I didn’t quite get that. Can you rephrase?";

      console.log("💬 GPT reply text:", replyText);

      // Save AI’s response to memory
      previousMessages.push({ role: "assistant", content: replyText });
      conversationMemory.set(from, previousMessages.slice(-10)); // keep last 10 messages max

      // Send SMS reply
      await twilioClient.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to: from,
        body: replyText,
      });

      console.log(`✅ Sent AI reply to ${from}`);
    } catch (err) {
      console.error("❌ Error during OpenAI call:", err);
      await twilioClient.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to: from,
        body: "Sorry, I'm having trouble connecting right now.",
      });
    }
  }, delayMs);
});

// --- WebSocket server (for voice) ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio-media" });

// --- Start server ---
server.listen(PORT, () => {
  console.log(`✅ Server listening on :${PORT}`);
  console.log(`🌐 TwiML endpoint: POST ${PUBLIC_BASE_URL}/twiml/voice`);
  console.log(`💬 SMS endpoint: POST ${PUBLIC_BASE_URL}/twiml/sms`);
  console.log(`🔗 WebSocket endpoint: ${PUBLIC_BASE_URL.replace(/^http/, "ws")}/twilio-media`);
});
