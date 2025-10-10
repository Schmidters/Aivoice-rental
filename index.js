// --- Imports & setup ---
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
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const REDIS_URL = process.env.REDIS_URL;
const DEBUG_SECRET = process.env.DEBUG_SECRET || "changeme123";

// --- Clients ---
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const redis = new Redis(REDIS_URL, { tls: false });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

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

// --- Utility ---
function slugify(str) {
  return str ? str.replace(/\s+/g, "-").replace(/[^\w\-]/g, "").toLowerCase() : "unknown";
}

// --- AI “read like a human” listing reader ---
async function aiReadListing(url) {
  try {
    console.log(`🌐 [AI-Read] Reading listing page → ${url}`);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a helpful real-estate assistant that reads rental listings and extracts factual data. 
You will be given a URL. Read the listing like a human (no scraping) and summarize key details:
- Parking situation
- Pet policy
- Utilities (included or not)
- Rent details
If unsure, say “not mentioned”. Return JSON only.`,
        },
        { role: "user", content: `Listing URL: ${url}` },
      ],
      response_format: { type: "json_object" },
      max_tokens: 400,
    });
    const data = completion.choices[0].message.content;
    const parsed = JSON.parse(data);
    console.log("✅ [AI-Read] Extraction complete:", parsed);
    return parsed;
  } catch (err) {
    console.error("❌ [AI-Read] Error reading page:", err.message);
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

app.get("/debug/memory", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  const keys = await redis.keys("conv:*");
  const data = {};
  for (const k of keys) data[k] = JSON.parse(await redis.get(k));
  res.json({ keys, data });
});

app.get("/debug/clear", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("Unauthorized");
  const { phone, property } = req.query;
  const slug = property ? slugify(property) : "unknown";
  await redis.del(`conv:${phone}:${slug}`, `facts:${phone}:${slug}`, `meta:${phone}:${slug}`);
  res.send(`🧹 Cleared data for ${phone}:${slug}`);
});

// --- Initialize property facts (from Zapier) ---
app.post("/init/facts", async (req, res) => {
  try {
    const { phone, property, listingUrl, rent, unit } = req.body;
    if (!phone || !property) return res.status(400).send("Missing phone or property");
    const slug = slugify(property);
    const base = { address: property, rent: rent || null, unit: unit || null, listingUrl: listingUrl || null };
    await setPropertyFacts(phone, slug, base);
    console.log(`💾 [Init] Facts initialized for ${phone}:${slug}`, base);
    res.send(`✅ Initialized facts for ${phone}:${slug}`);
  } catch (err) {
    console.error("❌ /init/facts error:", err);
    res.status(500).send(err.message);
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
  const from = req.body.From;
  const body = req.body.Body?.trim() || "";
  console.log(`📩 SMS from ${from}: ${body}`);
  res.type("text/xml").send("<Response></Response>");

  try {
    // Detect property name or address
    const propertyRegex =
      /([0-9]{2,5}\s?[A-Za-z]+\s?(Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|SE|SW|NW|NE|Southeast|Southwest|Northeast|Northwest))/i;
    const match = body.match(propertyRegex);
    const propertySlug = slugify(match ? match[0] : "unknown");

    const prev = await getConversation(from, propertySlug);
    const facts = await getPropertyFacts(from, propertySlug);

    // If we have a URL but no facts, trigger AI read
    if (facts.listingUrl && (!facts.parking || !facts.pets || !facts.utilities)) {
      const read = await aiReadListing(facts.listingUrl);
      Object.assign(facts, read);
      await setPropertyFacts(from, propertySlug, facts);
    }

    // Detect topic
    const topics = {
      parking: /\bparking\b/i.test(body),
      pets: /\b(pet|dog|cat)\b/i.test(body),
      utilities: /\b(utilit|electric|gas|heat|water)\b/i.test(body),
    };

    // Tone
    const tones = ["friendly", "casual", "warm", "helpful"];
    const tone = tones[Math.floor(Math.random() * tones.length)];

    // AI prompt
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
        const [, phone, property] = key.split(":");
        followups.push({ phone, property });
      }
    }

    for (const { phone, property } of followups) {
      const facts = await getPropertyFacts(phone, property);
      const text = facts?.address
        ? `Hey, just checking if you’d like to set up a showing for ${facts.address} 😊`
        : `Hey, just checking if you’re still interested in booking a showing 😊`;

      await twilioClient.messages.create({ from: TWILIO_PHONE_NUMBER, to: phone, body: text });
      console.log(`📆 Follow-up sent to ${phone}`);
    }

    res.send(`✅ Follow-ups sent: ${followups.length}`);
  } catch (err) {
    console.error("❌ Follow-up error:", err);
    res.status(500).send(err.message);
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
  console.log(`⏰ Follow-up cron: GET ${PUBLIC_BASE_URL}/cron/followups`);
});
