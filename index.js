// index.js
import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";
import Redis from "ioredis";
import OpenAI from "openai";
import slugify from "slugify";

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Redis setup ---
const redis = new Redis(process.env.REDIS_URL);

// --- Config ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BROWSEAI_API_KEY = process.env.BROWSEAI_API_KEY;
const BROWSEAI_ROBOT_ID = process.env.BROWSEAI_ROBOT_ID;
const DEBUG_SECRET = process.env.DEBUG_SECRET || "changeme123";

// --- Helpers ---
async function getCachedFacts(slug) {
  const cached = await redis.get(`facts:${slug}`);
  return cached ? JSON.parse(cached) : null;
}

async function saveFacts(slug, facts) {
  await redis.set(`facts:${slug}`, JSON.stringify(facts), "EX", 60 * 60 * 24); // 24h cache
  console.log(`💾 [Redis] Updated property facts`, slug);
}

async function fetchFromBrowseAI(url, slug) {
  console.log(`🤖 [BrowseAI] Triggering new run for ${url}`);
  const res = await fetch(`https://api.browse.ai/v2/robots/${BROWSEAI_ROBOT_ID}/tasks`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${BROWSEAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inputParameters: { "Origin URL": url } }),
  });
  const data = await res.json();
  console.log("✅ [BrowseAI] Task created", data?.id || "");
  return data;
}

// --- AI reasoning ---
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function askOpenAI(question, facts) {
  const context = Object.entries(facts || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  const messages = [
    {
      role: "system",
      content:
        "You are a friendly, helpful rental assistant. Use the property facts provided to answer renter questions clearly and naturally.",
    },
    {
      role: "user",
      content: `Property facts:\n${context}\n\nQuestion: ${question}`,
    },
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    max_tokens: 200,
  });

  return completion.choices[0].message.content.trim();
}

// --- Webhook endpoint ---
app.post("/browseai/webhook", async (req, res) => {
  try {
    const data = req.body;
    console.log("📦 [Webhook] BrowseAI data received");
    const summary = data?.results?.Summary || data?.results?.["Title Summary"] || "unknown";
    const slug = slugify(summary);
    await saveFacts(slug, data.results || data);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ [Webhook error]", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Manual trigger if needed ---
app.post("/init/fetch", async (req, res) => {
  const { property, url } = req.body;
  const slug = slugify(property);
  await fetchFromBrowseAI(url, slug);
  res.json({ ok: true });
});

// --- Twilio SMS handler ---
app.post("/sms", async (req, res) => {
  const incoming = req.body.Body?.trim() || "";
  const propertySlug = "215-16-street-southeast"; // could be dynamic
  const cachedFacts = await getCachedFacts(propertySlug);

  if (cachedFacts) {
    console.log("💾 [Cache hit]", propertySlug);
    const answer = await askOpenAI(incoming, cachedFacts);
    console.log("✅ SMS reply sent:", answer);
    return res.send(`<Response><Message>${answer}</Message></Response>`);
  } else {
    console.log("⚠️ [Cache miss] triggering BrowseAI...");
    await fetchFromBrowseAI(`https://rentals.ca/calgary/${propertySlug}`, propertySlug);
    const msg = "Thanks! I’m just gathering some details about this property — I’ll text you right back once I’ve got them.";
    return res.send(`<Response><Message>${msg}</Message></Response>`);
  }
});

// --- Debug endpoints ---
app.get("/debug/facts", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("unauthorized");
  const slug = req.query.property;
  const data = await getCachedFacts(slug);
  res.json(data || {});
});

app.get("/", (req, res) => {
  res.send("AI Voice Rental system is live.");
});

// --- Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
