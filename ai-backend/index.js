/**
 * Ava V7 — Manual-only backend
 * - Postgres (Prisma) is canonical storage for leads, properties, messages, bookings, property facts
 * - NO BrowseAI / NO Zapier; AI replies only use human-entered PropertyFacts fields
 */

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";
import twilio from "twilio";
import { PrismaClient } from "@prisma/client";
import cors from "cors";

dotenv.config();

const app = express();
const prisma = new PrismaClient();
// ---------- CORS CONFIG ----------
const allowedOrigins = [
  "https://ai-leasing-dashboard.onrender.com", // dashboard on Render
  "http://localhost:3000",                     // local dev
  "https://app.aivoicerental.com",             // future production domain
  "https://www.aivoicerental.com"
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn("❌ Blocked by CORS:", origin);
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "PUT", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);


// Middleware setup
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));




// ---------- ENV ----------
const {
  PORT = 3000,
  NODE_ENV = "production",
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_MESSAGING_SERVICE_SID,
  TWILIO_PHONE_NUMBER,
  TWILIO_FROM_NUMBER: ENV_TWILIO_FROM_NUMBER,
  DASHBOARD_ORIGIN = "*",
} = process.env;

const TWILIO_FROM_NUMBER = ENV_TWILIO_FROM_NUMBER || TWILIO_PHONE_NUMBER;

// ---------- GUARDS ----------
if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN)
  throw new Error("Missing Twilio credentials");
if (!TWILIO_MESSAGING_SERVICE_SID && !TWILIO_FROM_NUMBER)
  throw new Error(
    "Provide TWILIO_MESSAGING_SERVICE_SID or TWILIO_PHONE_NUMBER/TWILIO_FROM_NUMBER"
  );

// ---------- CORE ----------
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Simple logs
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});



const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ---------- HELPERS ----------
const normalizePhone = (num) => {
  if (!num) return "";
  let s = String(num).trim();
  if (!s.startsWith("+")) s = "+1" + s.replace(/[^\d]/g, "");
  return s;
};
const slugify = (s) =>
  (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)+/g, "");

// Link a lead to a property (if not already)
async function linkLeadToProperty(leadId, propertyId) {
  try {
    await prisma.leadProperty.upsert({
      where: { leadId_propertyId: { leadId, propertyId } },
      update: {},
      create: { leadId, propertyId },
    });
  } catch {}
}

async function upsertLeadByPhone(phone) {
  return prisma.lead.upsert({
    where: { phone },
    update: {},
    create: { phone },
  });
}
async function upsertPropertyBySlug(slug, address) {
  return prisma.property.upsert({
    where: { slug },
    update: address ? { address } : {},
    create: { slug, address },
  });
}

async function saveMessage({ phone, role, content, propertyId }) {
  const lead = await upsertLeadByPhone(phone);
  return prisma.message.create({
    data: {
      role,
      content,
      leadId: lead.id,
      propertyId: propertyId ?? null,
    },
  });
}

async function findBestPropertyForLeadFromDB(phone) {
  // Prefer linked property (via LeadProperty)
  const lead = await prisma.lead.findUnique({
    where: { phone },
    include: {
      properties: {
        include: {
          property: { include: { facts: true } },
        },
      },
    },
  });

  if (lead?.properties?.length) {
    // Take most recently updated property with facts if possible
    const propIds = lead.properties.map((lp) => lp.propertyId);
    const prop = await prisma.property.findFirst({
      where: { id: { in: propIds } },
      include: { facts: true },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });
    return prop;
  }

  // Fallback: just return most recently updated property overall (if any)
  const any = await prisma.property.findFirst({
    include: { facts: true },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  return any ?? null;
}

// ===========================================================
// 🧠 Try to detect property reference from message text
// ===========================================================
async function findPropertyFromMessage(text) {
  if (!text) return null;

  const allProps = await prisma.property.findMany({
    include: { facts: true },
  });

  const t = text.toLowerCase();

  for (const p of allProps) {
    const addr = (p.address || "").toLowerCase();
    const name = (p.facts?.buildingName || "").toLowerCase();

    // Match if message mentions address number or building name
    if (
      (addr && t.includes(addr.split(" ")[0])) ||
      (name && t.includes(name))
    ) {
      console.log(`🔍 Matched property by text: ${p.slug}`);
      return p;
    }
  }

  // Fallback to most recently updated property
  const latest = await prisma.property.findFirst({
    include: { facts: true },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });

  console.log("⚙️ Fallback to latest property:", latest?.slug);
  return latest;
}

function buildContextFromProperty(property) {
  const f = property?.facts || {};
  const lines = [];
  const unknown = (v) => (v == null || v === "" ? "Unknown" : v);

  lines.push(`Building Name: ${unknown(f.buildingName)}`);
  lines.push(`Address: ${unknown(f.address || property?.address)}`);
  lines.push(`Rent: ${unknown(f.rent)}`);
  lines.push(`Bedrooms: ${unknown(f.bedrooms)}`);
  lines.push(`Bathrooms: ${unknown(f.bathrooms)}`);
  lines.push(`Size: ${unknown(f.sqft)}`);
  lines.push(`Parking: ${unknown(f.parking)}`);
  lines.push(`Utilities: ${unknown(f.utilities)}`);
  lines.push(`Pets Allowed: ${
    f.petsAllowed === true ? "Yes" : f.petsAllowed === false ? "No" : "Unknown"
  }`);
  lines.push(`Furnished: ${
    f.furnished === true ? "Yes" : f.furnished === false ? "No" : "Unknown"
  }`);
  lines.push(`Availability: ${unknown(f.availability)}`);
  lines.push(`Managed By: ${unknown(f.managedBy)}`);
  lines.push(`Notes: ${unknown(f.notes)}`);

  return `PROPERTY FACTS (from database, human-entered):
${lines.join("\n")}
Only use facts that appear here. If a detail is missing, say "I'm not sure."`;
}


async function detectIntent(text) {
  const labels = [
    "book_showing",
    "pricing_question",
    "availability",
    "parking",
    "pets",
    "application_process",
    "negotiation",
    "general_info",
    "spam_or_unknown",
  ];
  try {
    const sys = `Classify into: ${labels.join(", ")}. Return ONLY the label.`;
    console.log("🧠 Context used for AI reply:\n", context);
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: text || "" },
      ],
    });
    const label = resp.choices?.[0]?.message?.content?.trim();
    return labels.includes(label) ? label : "general_info";
  } catch {
    return "general_info";
  }
}

async function aiReply({ incomingText, property, intent }) {
  const context = buildContextFromProperty(property);
  const system = `
You are a friendly, professional leasing assistant.
Use the provided property facts EXACTLY as written. If a detail is not present, don't invent it.
Keep replies concise (1–2 sentences). Never say you're an AI.`;
  try {
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.0,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `${context}\n\nLead intent: ${intent}\nLead message: ${incomingText}`,
        },
      ],
    });
    return resp.choices?.[0]?.message?.content?.trim() || "Thanks for reaching out!";
  } catch {
    return "Hey! Thanks for reaching out — when would you like to see the place?";
  }
}

async function sendSms(to, body) {
  const msg = { to, body };
  if (TWILIO_MESSAGING_SERVICE_SID) msg.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
  else msg.from = TWILIO_FROM_NUMBER;
  return twilioClient.messages.create(msg);
}

// ---------- ROUTES ----------


// Health
app.get("/", (req, res) => {
  res.json({ ok: true, service: "ai-backend-v7", time: new Date().toISOString() });
});

// Read-only list for dashboard (Property Data tab)
app.get("/api/properties", async (_req, res) => {
  try {
    const data = await prisma.propertyFacts.findMany({
      include: { property: true },
      orderBy: { updatedAt: "desc" },
    });
    res.json({ ok: true, data });
  } catch (err) {
    console.error("GET /api/properties failed:", err);
    res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "ai-backend-v7",
    time: new Date().toISOString(),
  });
});

// ===========================================================
// 🔹 INIT FACTS — Link new leads (from Zapier / Email Parser)
// ===========================================================

app.post("/init/facts", async (req, res) => {
  try {
    const { leadName, leadPhone, property, slug, message } = req.body;

    if (!leadPhone || !slug) {
      return res.status(400).json({ ok: false, error: "Missing phone or slug" });
    }

    const phone = normalizePhone(leadPhone);
    const propSlug = slugify(slug);

    // 🔍 Find or create the lead
    const lead = await upsertLeadByPhone(phone);

    // 🔍 Find the property in DB
    const propertyRecord = await prisma.property.findUnique({
      where: { slug: propSlug },
    });

    if (!propertyRecord) {
      return res.status(404).json({ ok: false, error: "Property not found" });
    }

    // ✅ Link this lead to the property
    await linkLeadToProperty(lead.id, propertyRecord.id);

    // ✅ Log the “welcome” or initial message (if any)
    if (message) {
      await saveMessage({
        phone,
        role: "assistant",
        content: message,
        propertyId: propertyRecord.id,
      });
    }

    console.log(`📎 Linked ${phone} → ${propSlug}`);
    res.json({ ok: true, linked: true });
  } catch (err) {
    console.error("❌ /init/facts error:", err);
    res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

// Property Editor — GET single property (for editing)
app.get("/api/property-editor/:slug", async (req, res) => {
  try {
    const slug = slugify(req.params.slug);

    const property = await prisma.property.findUnique({
      where: { slug },
      include: { facts: true },
    });

    if (!property) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    res.json({ ok: true, data: property });
  } catch (err) {
    console.error("GET /api/property-editor/:slug failed:", err);
    res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

// Property Editor — list all properties with facts
app.get("/api/property-editor", async (_req, res) => {
  try {
    const data = await prisma.property.findMany({
      include: { facts: true },
      orderBy: { updatedAt: "desc" },
    });
    res.json({ ok: true, data });
  } catch (err) {
  console.error("GET /api/property-editor failed:", err);
  res.status(500).json({ ok: false, error: err.message || "SERVER_ERROR" });
}
});

// 🔹 Leads API — used for dashboard metrics
app.get("/api/leads", async (_req, res) => {
  try {
    const leads = await prisma.lead.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({ ok: true, count: leads.length, data: leads });
  } catch (err) {
    console.error("GET /api/leads failed:", err);
    res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

// 🔹 Conversations API — used for dashboard activity feed
app.get("/api/conversations", async (_req, res) => {
  try {
    const messages = await prisma.message.findMany({
      orderBy: { createdAt: "desc" },
      take: 30,
    });

    // Group messages by conversation ID (usually phone number)
    const convMap = {};
    for (const m of messages) {
      if (!convMap[m.conversationId]) {
        convMap[m.conversationId] = {
          id: m.conversationId,
          property: m.propertySlug || null,
          lastMessage: m.content,
          lastTime: m.createdAt,
        };
      }
    }

    const conversations = Object.values(convMap);
    res.json({ ok: true, conversations });
  } catch (err) {
    console.error("GET /api/conversations failed:", err);
    res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});


// ===========================================================
// Property Editor — create or update property + all facts (Ava V7)
// ===========================================================

// CREATE new property + facts
app.post("/api/property-editor", async (req, res) => {
  try {
    const { slug: rawSlug, address, facts = {} } = req.body || {};
    if (!rawSlug) return res.status(400).json({ ok: false, error: "MISSING_SLUG" });

    const slug = slugify(rawSlug);
    const property = await upsertPropertyBySlug(slug, address);
    console.log("💾 [PropertyEditor] Creating new:", slug);

    // 🩹 Compatibility absorber — handle old "utilitiesIncluded" key safely
if (facts.utilitiesIncluded && !facts.includedUtilities) {
  facts.includedUtilities = facts.utilitiesIncluded;
}
delete facts.utilitiesIncluded;

    // Upsert all new manual fields (safe for null/missing)
    const updatedFacts = await prisma.propertyFacts.upsert({
      where: { propertyId: property.id },
      update: {
        buildingName: facts.buildingName || null,
        unitType: facts.unitType || null,
        rent: facts.rent || null,
        deposit: facts.deposit || null,
        leaseTerm: facts.leaseTerm || null,
        bedrooms: facts.bedrooms || null,
        bathrooms: facts.bathrooms || null,
        sqft: facts.sqft || null,
        parking: facts.parking || null,
        parkingOptions: facts.parkingOptions || null,
        utilities: facts.utilities || null,
        includedUtilities: facts.includedUtilities || null,
        petsAllowed: facts.petsAllowed ?? null,
        petPolicy: facts.petPolicy || null,
        furnished: facts.furnished ?? null,
        availability: facts.availability || null,
        notes: facts.notes || null,
        floorPlans: facts.floorPlans || null,
        amenities: facts.amenities || null,
        managedBy: facts.managedBy || null,
        listingUrl: facts.listingUrl || null,
        address: facts.address ?? address,
        units: facts.units || null, // ✅ support multiple unit types
        updatedAt: new Date(),
      },
      create: {
        propertyId: property.id,
        slug,
        address: facts.address ?? address,
        buildingName: facts.buildingName || null,
        unitType: facts.unitType || null,
        rent: facts.rent || null,
        deposit: facts.deposit || null,
        leaseTerm: facts.leaseTerm || null,
        bedrooms: facts.bedrooms || null,
        bathrooms: facts.bathrooms || null,
        sqft: facts.sqft || null,
        parking: facts.parking || null,
        parkingOptions: facts.parkingOptions || null,
        utilities: facts.utilities || null,
        includedUtilities: facts.includedUtilities || null,
        petsAllowed: facts.petsAllowed ?? null,
        petPolicy: facts.petPolicy || null,
        furnished: facts.furnished ?? null,
        availability: facts.availability || null,
        notes: facts.notes || null,
        floorPlans: facts.floorPlans || null,
        amenities: facts.amenities || null,
        managedBy: facts.managedBy || null,
        units: facts.units || null, // ✅ support multiple unit types
        listingUrl: facts.listingUrl || null,
      },
    });

    res.json({ ok: true, data: { property, facts: updatedFacts } });
  } catch (err) {
    console.error("POST /api/property-editor failed:", err);
    res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});


// UPDATE existing property + facts by slug
app.put("/api/property-editor/:slug", async (req, res) => {
  try {
    const slug = slugify(req.params.slug);
    const { address, facts = {} } = req.body || {};

    const property = await prisma.property.findUnique({ where: { slug } });
    if (!property) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    console.log("💾 [PropertyEditor] Updating:", slug);

    // 🩹 Handle backward compatibility for old key
    if (facts.utilitiesIncluded && !facts.includedUtilities) {
      facts.includedUtilities = facts.utilitiesIncluded;
    }
    delete facts.utilitiesIncluded;

    // ✅ Update the related propertyFacts record (upsert)
    const updatedFacts = await prisma.propertyFacts.upsert({
      where: { propertyId: property.id },
      update: {
        buildingName: facts.buildingName || null,
        unitType: facts.unitType || null,
        rent: facts.rent || null,
        deposit: facts.deposit || null,
        leaseTerm: facts.leaseTerm || null,
        bedrooms: facts.bedrooms || null,
        bathrooms: facts.bathrooms || null,
        sqft: facts.sqft || null,
        parking: facts.parking || null,
        parkingOptions: facts.parkingOptions || null,
        utilities: facts.utilities || null,
        includedUtilities: facts.includedUtilities || null,
        petsAllowed: facts.petsAllowed ?? null,
        petPolicy: facts.petPolicy || null,
        furnished: facts.furnished ?? null,
        availability: facts.availability || null,
        notes: facts.notes || null,
        floorPlans: facts.floorPlans || null,
        amenities: facts.amenities || null,
        managedBy: facts.managedBy || null,
        listingUrl: facts.listingUrl || null,
        address: facts.address ?? address,
        units: facts.units || null, 
        updatedAt: new Date(),
      },
      create: {
        propertyId: property.id,
        slug,
        address: facts.address ?? address,
        units: facts.units || null,  // ✅ add here too
        ...facts,
      },
    });

    console.log("✅ [PropertyEditor] Updated facts for:", slug);
    res.json({ ok: true, data: updatedFacts });
  } catch (err) {
    console.error("❌ [PropertyEditor] Failed to update:", err);
    res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});



// Bookings (kept minimal so your dashboard keeps working)
app.get("/api/bookings", async (_req, res) => {
  try {
    const list = await prisma.booking.findMany({
      include: { property: true, lead: true },
      orderBy: { id: "desc" },
      take: 100,
    });
    res.json({ ok: true, data: list });
  } catch (err) {
    console.error("GET /api/bookings failed:", err);
    res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

// Lightweight SSE for bookings "events" (heartbeat)
app.get("/api/bookings/events", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const iv = setInterval(() => {
    res.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  }, 15000);

  req.on("close", () => clearInterval(iv));
});

// ---------- Twilio inbound (AI reply uses ONLY manual facts) ----------
app.post("/twilio/sms", async (req, res) => {
  try {
    const from = normalizePhone(req.body.From);
    const incomingText = (req.body.Body || "").trim();
    if (!from || !incomingText) return res.status(400).end();

    // Find or create lead
    const lead = await upsertLeadByPhone(from);

    // Choose property for this lead
let property = await findBestPropertyForLeadFromDB(from);

// 🔍 Fallback: if lead isn’t linked yet, try to detect from message text
if (!property) {
  property = await findPropertyFromMessage(incomingText);
}

// 🧩 Log which property Ava is using
console.log("🧩 Using property for", from, "→", property?.slug || "none");


    // If no property linked yet but message mentions an address-like snippet, you could:
    // - parse and link here (omitted for V7 minimalism)

    const intent = await detectIntent(incomingText);

    // Booking short-circuit (kept from V6 but simplified)
    if (
      intent === "book_showing" ||
      /\b(?:am|pm|tomorrow|today|\b\d{1,2}[: ]?\d{0,2}\b)\b/i.test(incomingText)
    ) {
      const { DateTime } = await import("luxon");
      const tz = "America/Edmonton"; // Keep simple default for V7; you can refine by city later

      // naive time parse
      const m = incomingText.match(/\b(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?\b/i);
      if (!m) {
        await sendSms(from, "What time works best for you? (e.g., 'Sat 10:30am')");
        return res.status(200).end();
      }
      let hour = parseInt(m[1], 10);
      const minute = parseInt(m[2] || "0", 10);
      const mer = (m[3] || "").toLowerCase();
      if (mer === "pm" && hour < 12) hour += 12;
      if (mer === "am" && hour === 12) hour = 0;

      let when = DateTime.now().setZone(tz);
      if (incomingText.toLowerCase().includes("tomorrow")) when = when.plus({ days: 1 });

      const startAt = when.set({ hour, minute }).startOf("minute");

      const created = await prisma.booking.create({
        data: {
          phone: from,
          property: property ? { connect: { id: property.id } } : undefined,
          datetime: startAt.toJSDate(),
          source: "sms",
        },
      });

      await saveMessage({
        phone: from,
        role: "user",
        content: incomingText,
        propertyId: property?.id,
      });
      await saveMessage({
        phone: from,
        role: "assistant",
        content: `Booked ${startAt.toFormat("cccc, LLL d 'at' h:mm a")} (${tz.replace("America/", "")}).`,
        propertyId: property?.id,
      });

      await sendSms(
        from,
        `Perfect — you're booked for ${startAt.toFormat("cccc, LLL d 'at' h:mm a")} (${tz.replace(
          "America/",
          ""
        )}).`
      );

      console.log(`✅ Booking created for ${from} at ${startAt.toISO()}`);
      return res.status(200).end();
    }

    // Normal AI reply (manual facts only)
    const reply = await aiReply({ incomingText, property, intent });

    await saveMessage({ phone: from, role: "user", content: incomingText, propertyId: property?.id });
    await saveMessage({ phone: from, role: "assistant", content: reply, propertyId: property?.id });
    await sendSms(from, reply);

    console.log("💬 AI reply sent to", from, ":", reply);
    res.status(200).end();
  } catch (err) {
    console.error("❌ /twilio/sms error:", err);
    res.status(500).end();
  }
});



// ---------- Server start ----------
const renderPort = process.env.PORT || 10000;
app.listen(renderPort, "0.0.0.0", () => {
  console.log(`🚀 Ava V7 manual-only backend on :${renderPort} (${NODE_ENV})`);
});
