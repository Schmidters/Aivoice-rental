require("dotenv").config();
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const { DateTime } = require("luxon");
const twilio = require("twilio");
const Redis = require("ioredis");
const OpenAI = require("openai");

// --- App setup ---
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// --- Config ---
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://aivoice-rental.onrender.com";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const REDIS_URL = process.env.REDIS_URL;
const DEBUG_SECRET = process.env.DEBUG_SECRET || "changeme123";

// --- Clients ---
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const redis = new Redis(REDIS_URL, { tls: false });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- Helpers ---------------------------------------------------
function slugify(str) {
  return str ? str.replace(/\s+/g, "-").replace(/[^\w\-]/g, "").toLowerCase() : "unknown";
}

async function getConversation(phone, propertySlug) {
  const data = await redis.get(`conv:${phone}:${propertySlug}`);
  return data ? JSON.parse(data) : [];
}
async function saveConversation(phone, propertySlug, messages) {
  const key = `conv:${phone}:${propertySlug}`;
  await redis.set(key, JSON.stringify(messages.slice(-10)));
  await redis.hset(`meta:${phone}:${propertySlug}`, "lastInteraction", DateTime.now().toISO());
}
async function getPropertyFacts(phone, propertySlug) {
  const key = `facts:${phone}:${propertySlug}`;
  const data = await redis.get(key);
  return data ? JSON.parse(data) : {};
}
async function setPropertyFacts(phone, propertySlug, facts) {
  const key = `facts:${phone}:${propertySlug}`;
  await redis.set(key, JSON.stringify(facts));
  console.log(`💾 [Redis] Updated facts for ${phone}:${propertySlug}`);
}

// --- NEW: Let AI read the webpage like a human ----------------
async function aiReadListing(url) {
  if (!url) return {};
  console.log(`🌐 [AI-Read] Reading listing page → ${url}`);
  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,          // must support web reading
      messages: [
        {
          role: "system",
          content:
            "You are a rental assistant who can read webpages like a human. Extract concrete facts such as rent, parking, pets, utilities, amenities, and anything included. Return JSON only."
        },
        {
          role: "user",
          content: `Read this rental listing: ${url}`
        }
      ],
      tools: [{ type: "web", name: "open_url" }],
      max_tokens: 500
    });

    const text = completion.choices?.[0]?.message?.content;
    console.log("✅ [AI-Read] Extraction complete.");
    // Try to parse JSON if model produced it
    try {
      return JSON.parse(text);
    } catch {
      return { summary: text };
    }
  } catch (err) {
    console.error("❌ [AI-Read] error:", err.message);
    return {};
  }
}

// --- Health check ---
app.get("/", (req, res) => res.send("✅ AI Rental Assistant (with web reading) is running"));

// --- Initialize property facts from Zapier ---
app.post("/init/facts", async (req, res) => {
  try {
    const { phone, property, listingUrl, rent, unit } = req.body;
    if (!phone || !property) return res.status(400).send("Missing phone or property");
    const propertySlug = slugify(property);
    const facts = { listingUrl, address: property, rent, unit };
    await setPropertyFacts(phone, propertySlug, facts);
    res.send(`✅ Initialized facts for ${phone}:${propertySlug}`);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// --- SMS webhook ----------------------------------------------
app.post("/twiml/sms", async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim() || "";
  console.log(`📩 SMS from ${from}: ${body}`);
  res.type("text/xml").send("<Response></Response>");

  try {
    // detect property
    const propertyRegex =
      /(?:for|about|regarding|at)?\s*([0-9]{2,5}\s?[A-Za-z]+\s?(Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|SE|SW|NW|NE|Southeast|Southwest|Northeast|Northwest))/i;
    const match = body.match(propertyRegex);
    const propertySlug = slugify(match ? match[1] : "unknown");

    const prev = await getConversation(from, propertySlug);
    const facts = await getPropertyFacts(from, propertySlug);

    // --- NEW: if we have a listingUrl but no extracted facts yet
    if (facts.listingUrl && !facts.extracted) {
      console.log("🧠 [AI-Read] Fetching structured info from listing...");
      const extracted = await aiReadListing(facts.listingUrl);
      if (Object.keys(extracted).length > 0) {
        facts.extracted = extracted;
        await setPropertyFacts(from, propertySlug, facts);
      }
    }

    // Compose system message with known facts
    const systemPrompt = {
      role: "system",
      content: `
You are Alex, a natural-sounding rental assistant.
Known property info: ${JSON.stringify(facts)}.
Be friendly and brief. Use the facts to answer questions.
If something isn't known, say it's not mentioned politely.`
    };

    const messages = [systemPrompt, ...prev, { role: "user", content: body }];

    const aiResp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 200
    });

    const reply = aiResp.choices?.[0]?.message?.content?.trim() || "Hmm, could you say that again?";
    console.log("💬 GPT reply:", reply);

    const updated = [...prev, { role: "user", content: body }, { role: "assistant", content: reply }];
    await saveConversation(from, propertySlug, updated);
    await twilioClient.messages.create({ from: TWILIO_PHONE_NUMBER, to: from, body: reply });
    console.log(`✅ Sent reply to ${from}`);
  } catch (err) {
    console.error("❌ SMS error:", err);
  }
});

// --- Follow-up cron stays unchanged ----------------------------
app.get("/cron/followups", async (req, res) => { /* ... your existing follow-up code ... */ });

// --- WebSocket handler (unchanged) -----------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio-media") wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  else socket.destroy();
});
wss.on("connection", ws => {
  console.log("🔊 Twilio media stream connected!");
  ws.on("message", msg => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === "start") console.log("🎬 Stream started:", data.streamSid);
      if (data.event === "stop") console.log("🛑 Stream stopped:", data.streamSid);
    } catch (err) {
      console.error("⚠️ WS message parse error:", err);
    }
  });
});

// --- Start server ----------------------------------------------
server.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(`💬 SMS endpoint: POST ${PUBLIC_BASE_URL}/twiml/sms`);
  console.log(`🌐 Voice endpoint: POST ${PUBLIC_BASE_URL}/twiml/voice`);
  console.log(`🧠 Init facts endpoint: POST ${PUBLIC_BASE_URL}/init/facts`);
});
