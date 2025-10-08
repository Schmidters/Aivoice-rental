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

// --- μ-law decode helpers (for voice) ---
function mulawDecodeSample(mu) {
  const MULAW_BIAS = 33;
  mu = ~mu & 0xff;
  const sign = mu & 0x80;
  let exponent = (mu >> 4) & 0x07;
  let mantissa = mu & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << (exponent + 3);
  sample = sign ? 0x84 - sample : sample - 0x84;
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;
  return sample;
}

function mulawToPCM16(bufMuLawB64) {
  const raw = Buffer.from(bufMuLawB64, "base64");
  const out = Buffer.alloc(raw.length * 2);
  for (let i = 0; i < raw.length; i++) {
    const pcm = mulawDecodeSample(raw[i]);
    out.writeInt16LE(pcm, i * 2);
  }
  return out;
}

function toBase64(buf) {
  return buf.toString("base64");
}

// --- Express app ---
const app = express();
app.use(urlencoded({ extended: false }));

// ✅ Health check
app.get("/", (req, res) => {
  res.send("✅ AI Voice Rental Assistant is live on Render!");
});

// ✅ Debug endpoint to verify which API key is loaded
app.get("/debug/openai", (req, res) => {
  const key = process.env.OPENAI_API_KEY || "none";
  res.send(`Current API key starts with: ${key.slice(0, 10)}...`);
});

// ✅ Voice test route
app.get("/twiml/voice", (req, res) => {
  res.type("text/xml");
  res.send(`<Response><Say>Hello! This is a test. Your Twilio connection works.</Say></Response>`);
});

// 🧠 Twilio Voice route
app.post("/twiml/voice", (req, res) => {
  const wsUrl = `${PUBLIC_BASE_URL.replace(/^http/, "ws")}/twilio-media`;
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

// 💬 Twilio SMS route — direct OpenAI test
app.post("/twiml/sms", express.urlencoded({ extended: false }), async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim() || "";

  console.log(`📩 SMS from ${from}: ${body}`);

  // Respond immediately to Twilio
  res.type("text/xml");
  res.send("<Response></Response>");

  const delayMs = 10000 + Math.random() * 10000;

  setTimeout(async () => {
    try {
      console.log("➡️ Sending to OpenAI:", body);

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
                "You are a warm, natural-sounding rental assistant. Be friendly, brief, and helpful. Ask simple follow-ups about showings or property details.",
            },
            { role: "user", content: body },
          ],
          max_tokens: 120,
        }),
      });

      const data = await response.json();
      console.log("🧠 Full OpenAI response:", JSON.stringify(data, null, 2));

      const replyText =
        data.choices?.[0]?.message?.content?.trim() ||
        "Hmm, I didn’t quite get that. Can you rephrase?";

      console.log("💬 GPT reply text:", replyText);

      // Send SMS via Twilio
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
        body: "Sorry, I'm having trouble connecting to the assistant right now.",
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
