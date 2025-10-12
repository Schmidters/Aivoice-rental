import "dotenv/config.js";
import express from "express";
import twilio from "twilio";
import Redis from "ioredis";
import OpenAI from "openai";
import fetch from "node-fetch";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Config ---
const {
  PORT = 3000,
  PUBLIC_BASE_URL,
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  REDIS_URL,
  BROWSEAI_KEY,
  BROWSEAI_ROBOT_ID,
  DEBUG_SECRET = "changeme123",
} = process.env;

// --- Clients ---
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const redis = new Redis(REDIS_URL);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- Helpers ---
const slugify = s => s?.toLowerCase().replace(/\s+/g, "-").replace(/[^\w\-]/g, "") || "unknown";
const now = () => new Date().toISOString();

async function getFacts(slug) {
  const f = await redis.get(`facts:${slug}`);
  return f ? JSON.parse(f) : null;
}
async function saveFacts(slug, facts) {
  await redis.set(`facts:${slug}`, JSON.stringify(facts));
  console.log(`💾 saved BrowseAI facts for ${slug}`);
}

// --- Browse AI fetcher ---
async function fetchWithBrowseAI(url) {
  const start = await fetch(`https://api.browse.ai/v2/robots/${BROWSEAI_ROBOT_ID}/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${BROWSEAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ startUrls: [url] }),
  });
  const job = await start.json();
  const runId = job.id || job.data?.id;
  if (!runId) throw new Error("BrowseAI missing run id");

  // Poll for completion
  let result = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    await new Promise(r => setTimeout(r, 3000));
    const poll = await fetch(`https://api.browse.ai/v2/runs/${runId}`, {
      headers: { Authorization: `Bearer ${BROWSEAI_KEY}` },
    });
    const j = await poll.json();
    const status = j.status || j.data?.status;
    if (status === "succeeded" || status === "completed") {
      result = j.result || j.data?.result || j.data;
      break;
    }
    if (["failed", "errored", "canceled"].includes(status)) break;
  }
  if (!result) throw new Error("BrowseAI run timeout");
  const data = result.data || result.items || {};
  return data;
}

// --- Ask OpenAI using Browse AI data ---
async function askAI(question, facts) {
  const messages = [
    {
      role: "system",
      content:
        "You are a helpful rental assistant. Use only the structured JSON data from the listing to answer accurately and concisely.",
    },
    { role: "user", content: `FACTS:\n${JSON.stringify(facts, null, 2)}` },
    { role: "user", content: `QUESTION:\n${question}` },
  ];
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    temperature: 0.2,
    max_tokens: 200,
  });
  return resp.choices[0].message.content.trim();
}

// --- Twilio SMS handler ---
app.post("/twiml/sms", async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || "").trim();
  console.log(`📩 SMS from ${from}: ${body}`);
  res.type("text/xml").send("<Response></Response>");

  // look up last property slug
  const slug = await redis.get(`lastprop:${from}`);
  const facts = slug ? await getFacts(slug) : null;

  if (!slug || !facts) {
    await twilioClient.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to: from,
      body: "Hi! Can you send me the property link or address?",
    });
    return;
  }

  const answer = await askAI(body, facts);
  await twilioClient.messages.create({
    from: TWILIO_PHONE_NUMBER,
    to: from,
    body: answer,
  });
  console.log(`✅ replied to ${from}`);
});

// --- Endpoint to fetch & store facts from Browse AI manually ---
app.post("/init/fetch", async (req, res) => {
  try {
    const { property, url } = req.body;
    if (!property || !url) return res.status(400).json({ error: "Need property + url" });
    const slug = slugify(property);
    const data = await fetchWithBrowseAI(url);
    await saveFacts(slug, { ...data, listingUrl: url, updatedAt: now() });
    await redis.set(`lastprop:test`, slug); // simple test binding
    res.json({ ok: true, slug, keys: Object.keys(data) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// --- Debug route to inspect facts ---
app.get("/debug/facts", async (req, res) => {
  if (req.query.key !== DEBUG_SECRET) return res.status(401).send("unauthorized");
  const slug = slugify(req.query.property || "");
  const facts = await getFacts(slug);
  res.json(facts);
});

app.listen(PORT, () => console.log(`✅ running on port ${PORT}`));
