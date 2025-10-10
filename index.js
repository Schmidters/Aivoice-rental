// --- Imports & setup ---
import "dotenv/config.js";
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { DateTime } from "luxon";
import twilio from "twilio";
import Redis from "ioredis";
import OpenAI from "openai";
import { parsePhoneNumberFromString } from "libphonenumber-js";

// --- App setup ---
const app = express();
app.use(express.urlencoded({ extended: false }));
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

// --- Clients ---
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const redis = new Redis(REDIS_URL, { tls: false });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- Helpers ---
function normalizePhone(phone) {
  if (!phone) return null;
  const parsed = parsePhoneNumberFromString(phone, "CA");
  return parsed && parsed.isValid() ? parsed.number : phone;
}

function slugify(str) {
  return str ? str.replace(/\s+/g, "-").replace(/[^\w\-]/g, "").toLowerCase() : "unknown";
}

// --- Redis helpers ---
async function getConversation(phone, property) {
  const key = `conv:${phone}:${property}`;
  const data = await redis.get(key);
  return data ? JSON.parse(data) : [];
}
async function saveConversation(phone, property, messages) {
  const key = `conv:${phone}:${property}`;
  const metaKey = `meta:${phone}:${property}`;
  await redis.set(key, JSON.stringify(messages.slice(-10)));
  await redis.hset(metaKey, "lastInteraction", DateTime.now().toISO());
}
async function getPropertyFacts(phone, property) {
  const key = `facts:${phone}:${property}`;
  const data = await redis.get(key);
  return data ? JSON.parse(data) : {};
}
async function setPropertyFacts(phone, property, facts) {
  const key = `facts:${phone}:${property}`;
  await redis.set(key, JSON.stringify(facts));
  console.log(`💾 [Redis] Updated facts for ${phone}:${property}`);
}

// --- GPT-4.1 with browsing ---
async function aiReadListing(url) {
  console.log(`🌐 [AI-Read] Browsing page → ${url}`);

  try {
    const assistant = await openai.beta.assistants.create({
      name: "Rental Listing Reader",
      instructions: `You are a real-estate assistant that uses the browser tool to open
      rental listings and extract factual details:
      - Parking situation
      - Pet policy
      - Utilities (included or not)
      - Rent details
      Return a JSON object only.`,
      model: "gpt-4.1",
      tools: [{ type: "browser" }],
    });

    const thread = await openai.beta.threads.create({
      messages: [{ role: "user", content: `Read ${url} and extract the required facts.` }],
    });

    const run = await openai.beta.threads.runs.createAndPoll(thread.id, {
      assistant_id: assistant.id,
    });

    const messages = await openai.beta.threads.messages.list(thread.id);
    const result = messages.data.find((m) => m.role === "assistant");

    let parsed = {};
    if (result?.content?.[0]?.text?.value) {
      try {
        parsed = JSON.parse(result.content[0].text.value);
      } catch {
        parsed = { raw: result.content[0].text.value };
      }
    }

    console.log("✅ [AI-Read] Extraction complete:", parsed);
    return parsed;
  } catch (err) {
    console.error("❌ [AI-Read] Error:", err.message);
    return {};
  }
}

// --- Health check ---
app.get("/", (req, res) => res.send("✅ AI Rental Assistant is running"));

// --- Debug routes ---
app.get("/debug/facts", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  const { phone, property } = req.query;
  if (!phone) return res.status(400).send("Missing phone");
  const slug = property ? slugify(property) : "unknown";
  const facts = await getPropertyFacts(phone, slug);
  res.json({ phone, property: slug, facts });
});

// --- Initialize property facts (from Zapier) ---
app.post("/init/facts", async (req, res) => {
  try {
    let { phone, property, listingUrl, rent, unit } = req.body;
    if (!phone || !property) {
      return res.status(400).json({ error: "Missing phone or property" });
    }

    phone = normalizePhone(phone);
    const slug = slugify(property);

    const facts = {
      phone,
      property: slug,
      address: property,
      rent: rent || null,
      unit: unit || null,
      listingUrl: listingUrl || null,
      initializedAt: new Date().toISOString(),
    };

    await setPropertyFacts(phone, slug, facts);
    console.log(`💾 [Init] Facts initialized for ${phone}:${slug}`, facts);

    // --- Auto-enrich via GPT-4.1 browser ---
    if (listingUrl) {
      const read = await aiReadListing(listingUrl);
      Object.assign(facts, read);
      await setPropertyFacts(phone, slug, facts);
    }

    res.status(200).json({
      success: true,
      message: "Initialized and enriched facts successfully",
      data: facts,
      redisKey: `facts:${phone}:${slug}`,
    });
  } catch (err) {
    console.error("❌ /init/facts error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Voice webhook ---
app.post("/twiml/voice", (req, res) => {
  const twiml = `
<Response>
  <Connect><Stream url="wss://aivoice-rental.onrender.com/twilio-media" /></Connect>
  <Say voice="Polly.Joanna">Hi, connecting you to the rental assistant now.</Say>
</Response>`.trim();
  res.type("text/xml").send(twiml);
});

// --- SMS webhook ---
app.post("/twiml/sms", async (req, res) => {
  const from = normalizePhone(req.body.From);
  const body = req.body.Body?.trim() || "";
  console.log(`📩 SMS from ${from}: ${body}`);
  res.type("text/xml").send("<Response></Response>");

  try {
    const propertyRegex =
      /([0-9]{2,5}\s?[A-Za-z]+\s?(Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|SE|SW|NW|NE|Southeast|Southwest|Northeast|Northwest))/i;
    const match = body.match(propertyRegex);
    const propertySlug = slugify(match ? match[0] : "unknown");

    const prev = await getConversation(from, propertySlug);
    const facts = await getPropertyFacts(from, propertySlug);

    const topics = {
      parking: /\bparking\b/i.test(body),
      pets: /\b(pet|dog|cat)\b/i.test(body),
      utilities: /\b(utilit|electric|gas|heat|water)\b/i.test(body),
    };

    const tones = ["friendly", "casual", "warm", "helpful"];
    const tone = tones[Math.floor(Math.random() * tones.length)];

    const systemPrompt = {
      role: "system",
      content: `You are Alex, a ${tone} rental assistant. Known property facts: ${JSON.stringify(facts)}.
If the user asks about parking, pets, or utilities, use these facts directly.
If missing, say “not mentioned” politely. Keep replies under 3 sentences.`,
    };

    const messages = [systemPrompt, ...prev, { role: "user", content: body }];

    const aiResp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 200,
    });
    const reply = aiResp.choices?.[0]?.message?.content?.trim() || "Hmm, could you repeat that?";

    console.log("💬 GPT reply:", reply);

    const updated = [...prev, { role: "user", content: body }, { role: "assistant", content: reply }];
    await saveConversation(from, propertySlug, updated);
    await twilioClient.messages.create({ from: TWILIO_PHONE_NUMBER, to: from, body: reply });
    console.log(`✅ Sent reply to ${from}`);
  } catch (err) {
    console.error("❌ SMS error:", err);
  }
});

// --- WebSocket for voice streaming ---
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
      console.error("⚠️ WS parse error:", err);
    }
  });
});

// --- Start server ---
server.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(`💬 SMS endpoint: POST ${PUBLIC_BASE_URL}/twiml/sms`);
  console.log(`🌐 Voice endpoint: POST ${PUBLIC_BASE_URL}/twiml/voice`);
  console.log(`🧠 Init facts endpoint: POST ${PUBLIC_BASE_URL}/init/facts`);
});
