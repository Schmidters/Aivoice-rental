/**
 * Ava V7 — Manual-only backend
 * - Postgres (Prisma) is canonical storage for leads, properties, messages, bookings, property facts
 * - Outlook integration: OAuth (connect) + sync (availability + event creation)
 */

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";
import twilio from "twilio";
import { PrismaClient } from "@prisma/client";
import cors from "cors";
import cookieParser from "cookie-parser";
import { generateAvaResponse } from "./utils/generateAvaResponse.js";
import { getAvailabilityContext } from "./utils/getAvailabilityContext.js";

// Routers
import bookingsRouter from "./routes/bookings.js";
import availabilityRouter from "./routes/availability.js";
import outlookAuthRouter from "./routes/outlookAuth.js";   // OAuth connect/callback
import outlookRouter from "./routes/outlook.js";           // availability + event creation
import outlookSyncRouter from "./routes/outlook-sync.js";  // webhook + sync

dotenv.config();

// ---------- CORE SETUP ----------
const app = express();                      // 👈 must come before app.get
app.set("trust proxy", 1);
const prisma = new PrismaClient();


// ====================================================
// 🧠 SECURITY + CORS SETUP (goes right after app + prisma)
// ====================================================

import helmet from "helmet";
import xss from "xss-clean";
import rateLimit from "express-rate-limit";

// --- Core security middleware ---
app.use(helmet()); // adds secure headers
app.use(xss());    // sanitize input

// Basic rate limiting to protect from spam / brute force
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200,                 // per IP
  })
);

// --- Strict CORS setup ---
const allowedOrigins = [
  "https://dashboard.cubbylockers.com",     // ✅ production dashboard
  "https://aivoice-rental.digitalocean.com",// ✅ temp backend
  "http://localhost:3000",                  // ✅ local dev
  "https://app.aivoicerental.com",
  "https://www.aivoicerental.com",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true); // allow webhooks/no-origin
      if (allowedOrigins.includes(origin)) return callback(null, true);
      console.warn("❌ Blocked by CORS:", origin);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  })
);


// --- Force HTTPS in production ---
app.use((req, res, next) => {
  if (
    process.env.NODE_ENV === "production" &&
    req.header("x-forwarded-proto") !== "https"
  ) {
    return res.redirect(`https://${req.header("host")}${req.url}`);
  }
  next();
});



// ---------- ENV ----------
const {
  PORT = 10000,
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

// ---------- GUARDS ----------
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN)
  console.warn("⚠️ Twilio credentials not found yet — retrying later");
if (!process.env.DATABASE_URL)
  throw new Error("Missing DATABASE_URL");

const TWILIO_FROM_NUMBER = ENV_TWILIO_FROM_NUMBER || TWILIO_PHONE_NUMBER;


// ---------- CORE SETUP ----------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);


// ---------- Middleware ----------
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser(process.env.OAUTH_COOKIE_SECRET));

// Simple logs
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Allow webhooks to bypass strict CORS
app.use("/twilio", cors());
app.use("/browseai", cors());
app.use("/init", cors());
app.use("/outlook", cors());


// ---------- Routes ----------
app.use("/api/bookings", bookingsRouter);
app.use("/api/availability", availabilityRouter);
app.use("/api/outlook", outlookRouter);             // availability + event creation
app.use("/api/outlook-auth", outlookAuthRouter);    // OAuth connect/callback
app.use("/api/outlook-sync", outlookSyncRouter);    // webhook + Graph sync


// ---------- Healthcheck ----------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    env: NODE_ENV,
    time: new Date().toISOString(),
  });
});


// ---------- HELPERS ----------
const normalizePhone = (num) => {
  if (!num) return "";
  let s = String(num).trim();
  if (!s.startsWith("+")) s = "+1" + s.replace(/[^\d]/g, "");
  return s;
};
const slugify = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");

// ✅ Always re-link a lead to the latest property they inquire about
async function linkLeadToProperty(leadId, propertyId) {
  try {
    // 🧹 Remove any old property links for this lead
    await prisma.leadProperty.deleteMany({ where: { leadId } });

    // 🔗 Create a fresh link to the latest property
    await prisma.leadProperty.create({
      data: { leadId, propertyId },
    });

    console.log(`📎 Linked lead ${leadId} → property ${propertyId}`);
  } catch (err) {
    console.error("❌ Error linking lead to property:", err);
  }
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

  const add = (label, value) => {
    if (value != null && value !== "") lines.push(`${label}: ${value}`);
  };

  // Build factual dataset
  add("Building Name", f.buildingName);
  add("Address", f.address || property?.address);
  add("Rent", f.rent);
  add("Bedrooms", f.bedrooms);
  add("Bathrooms", f.bathrooms);
  add("Size", f.sqft);
  add("Parking", f.parking);
  add("Utilities", f.utilities);
  add("Pets Allowed", f.petsAllowed ? "Yes" : f.petsAllowed === false ? "No" : "");
  add("Furnished", f.furnished ? "Yes" : f.furnished === false ? "No" : "");
  add("Availability", f.availability);
  add("Managed By", f.managedBy);
  add("Notes", f.notes);
  add("Deposit", f.deposit);
  add("Lease Type", f.leaseType);
  add("Amenities", f.amenities);
  add("Pet Policy", f.petPolicy);
  add("Utilities Included", f.utilitiesIncluded);

  const knownFacts = lines.length;

  return `
PROPERTY FACTS (verified data entered by a human):
${lines.join("\n")}

You can trust and confidently refer to any of these facts in conversation.
If a question involves something not listed here, respond naturally with:
"I'm not sure about that, but I can find out for you."

There are ${knownFacts} known facts provided — assume they are accurate and current.
Never say “I think” or “I don’t have that info” when the data is listed above.
`;
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

async function aiReply({ incomingText, property, intent, availabilityContext }) {
  const context = buildContextFromProperty(property);

  const hours = availabilityContext?.globalHours || {};
  const availableSlots = availabilityContext?.availableSlots || [];
  const blockedSlots = availabilityContext?.blockedSlots || [];

  const system = `
You are "Ava", a professional and personable leasing assistant for a real estate company.

You speak like a real person who works in property management — warm, confident, and natural in tone. 
You never sound robotic or overly formal.

Your goal is to help renters inquire about properties and book showings.

### RULES:
- Base answers only on the provided PROPERTY FACTS and AVAILABILITY INFO below.
- Offer showing times only within open hours and unblocked slots.
- If a slot is unavailable, suggest the next available open slot.
- Never promise times outside open hours.
- Keep SMS replies short, conversational, and natural.

### PROPERTY FACTS:
${context}

### GLOBAL OPEN HOURS:
${JSON.stringify(hours, null, 2)}

### AVAILABLE SLOTS:
${JSON.stringify(availableSlots.slice(0, 5), null, 2)}

### BLOCKED SLOTS:
${JSON.stringify(blockedSlots.slice(0, 5), null, 2)}
`;


  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.7, // give her a bit of tone variation
    messages: [
      { role: "system", content: system },
      { role: "user", content: `Lead message: ${incomingText}` },
    ],
  });

  return resp.choices?.[0]?.message?.content?.trim() || "Thanks for reaching out!";
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

import { DateTime } from "luxon";

/**
 * 🔍 Find next available 30-minute slots for showings
 * Scans Availability + GlobalSettings and returns next 2 free times
 */
async function findNextAvailableSlots(propertyId, requestedStart, count = 2) {
  const tz = "America/Edmonton";

  // Load global open hours
  const settings = await prisma.globalSettings.findFirst();
  const openStart = settings?.openStart || "08:00";
  const openEnd = settings?.openEnd || "17:00";

  // Load all busy slots for the property
  const busy = await prisma.availability.findMany({
    where: {
      propertyId,
      isBlocked: true,
      endTime: { gte: new Date() },
    },
    orderBy: { startTime: "asc" },
  });

  const results = [];
  let start = DateTime.fromJSDate(requestedStart).setZone(tz);

  // Step forward in 30-minute increments until we find `count` free slots
  while (results.length < count) {
    const dayStart = start.startOf("day").plus({
      hours: parseInt(openStart.split(":")[0]),
      minutes: parseInt(openStart.split(":")[1]),
    });
    const dayEnd = start.startOf("day").plus({
      hours: parseInt(openEnd.split(":")[0]),
      minutes: parseInt(openEnd.split(":")[1]),
    });

    // Ensure we're inside open hours
    if (start < dayStart) start = dayStart;
    if (start > dayEnd) start = dayEnd.plus({ days: 1 }).set({ hour: 8 });

    const end = start.plus({ minutes: 30 });

    // Check overlap with busy slots
    const overlap = busy.some(
      (b) =>
        start.toMillis() < new Date(b.endTime).getTime() &&
        end.toMillis() > new Date(b.startTime).getTime()
    );

    if (!overlap && start >= DateTime.now().setZone(tz)) {
      results.push(start);
    }

    start = start.plus({ minutes: 30 });
  }

  return results.map((s) => s.toFormat("ccc, LLL d 'at' h:mm a"));
}

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

    // =======================================================
// 🧩 AI scheduling flow — checks availability, books via DB
// =======================================================
if (
  intent === "book_showing" ||
  /\b(?:am|pm|tomorrow|today|\b\d{1,2}[: ]?\d{0,2}\b)\b/i.test(incomingText)
) {
  const { DateTime } = await import("luxon");
  const tz = "America/Edmonton"; // default; can be refined later per property
  const now = DateTime.now().setZone(tz);

  // 🧠 Step 1: Try to detect a date/time from the message
  const match = incomingText.match(
    /\b(?:(mon|tue|wed|thu|fri|sat|sun)\w*)?\s*(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?\b/i
  );
  if (!match) {
    await sendSms(from, "What day and time works best for you?");
    return res.status(200).end();
  }

  const weekday = match[1]?.toLowerCase();
  let hour = parseInt(match[2], 10);
  const minute = parseInt(match[3] || "0", 10);
  const meridian = (match[4] || "").toLowerCase();
  if (meridian === "pm" && hour < 12) hour += 12;
  if (meridian === "am" && hour === 12) hour = 0;

  let date = now;
  if (weekday) {
    const target = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(weekday.slice(0, 3));
    const diff = (target - date.weekday + 7) % 7 || 7;
    date = date.plus({ days: diff });
  } else if (incomingText.toLowerCase().includes("tomorrow")) {
    date = date.plus({ days: 1 });
  }

  const requestedStart = date.set({ hour, minute, second: 0, millisecond: 0 }).toJSDate();

// 🧠 Step 2: Check if that time slot is available via DB + Outlook
const availabilityContext = await getAvailabilityContext(property?.id);
const { availableSlots, blockedSlots } = availabilityContext;


// ✅ Normalize requested time to the same timezone
const requestedDT = DateTime.fromJSDate(requestedStart).setZone(tz);

// ⛔ Prevent bookings in the past
if (requestedDT <= DateTime.now().setZone(tz)) {
await sendSms(from, await generateAvaResponse("past_time"));
  return res.status(200).end();
}

// ✅ Compare against each blocked slot using the same tz
const isBlocked = blockedSlots.some((b) => {
  const bStart = DateTime.fromISO(b.start, { zone: tz });
  const bEnd = DateTime.fromISO(b.end, { zone: tz });
  return requestedDT >= bStart && requestedDT < bEnd;
});

// (Optional) Log comparison for debugging
console.log(
  "[BOOKING CHECK] requestedDT:",
  requestedDT.toISO(),
  "blockedSlots:",
  blockedSlots.length
);



if (isBlocked) {
  const nextSlots = await findNextAvailableSlots(property.id, requestedStart, 2);

  if (nextSlots.length) {
    await sendSms(from, await generateAvaResponse("slot_taken", { nextSlots }));
  } else {
    await sendSms(from, await generateAvaResponse("no_slots"));
  }

  return res.status(200).end();
}


// ✅ Slot is free — create the booking
const booking = await prisma.booking.create({
  data: {
    leadId: lead.id,
    propertyId: property.id,
    datetime: requestedStart,
    status: "confirmed",
  },
});

const startFmt = requestedDT.setZone(tz).toFormat("ccc, LLL d 'at' h:mm a");
await sendSms(
  from,
  await generateAvaResponse("booking_confirmed", {
    startFmt,
    propertyName: property?.facts?.buildingName || property?.address,
  })
);
console.log(`✅ Booking confirmed for ${from} at ${startFmt}`);

// 💾 Save message record
await saveMessage({
  phone: from,
  role: "assistant",
  content: `Perfect — you're booked for ${startFmt}.`,
  propertyId: property?.id,
});

// 📅 Sync to Outlook
try {
  const outlookUrl = `${process.env.NEXT_PUBLIC_AI_BACKEND_URL || "https://aivoice-rental.onrender.com"}/api/outlook-sync/create-event`;
  const outlookPayload = {
    subject: `Showing — ${property?.facts?.buildingName || property?.address || "Property"}`,
    startTime: requestedDT.toISO(),
    endTime: requestedDT.plus({ minutes: 30 }).toISO(),
    location: property?.facts?.address || property?.address || "TBD",
    leadEmail: "renter@example.com",
  };

  const outlookRes = await fetch(outlookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(outlookPayload),
  });

  const outlookData = await outlookRes.json();
  if (outlookData.success) {
    console.log("📆 Outlook event created:", outlookData.event.id);
    await prisma.booking.update({
      where: { id: booking.id },
      data: { notes: `Outlook Event ID: ${outlookData.event.id}` },
    });
  } else {
    console.warn("⚠️ Failed to create Outlook event:", outlookData);
  }
} catch (err) {
  console.error("❌ Outlook calendar sync failed:", err.message);
}

return res.status(200).end();


  // 🧠 Step 4: Fallback (error)
  console.error("❌ Booking API error:", json.error);
  await sendSms(from, "Sorry, I couldn’t confirm that time. Can you try another?");
  return res.status(200).end();
}


// 🧠 Fetch live availability context
const availabilityContext = await getAvailabilityContext(property?.id);

// 🧩 Combine property facts and showing availability
const reply = await aiReply({
  incomingText,
  property,
  intent,
  availabilityContext,
});


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

// -----------------------------
// Availability (open hours)
// -----------------------------

// 🕑 Auto-refresh Outlook tokens daily (every 24 hours)
import fetch from "node-fetch";

async function refreshOutlookTokens() {
  const accounts = await prisma.calendarAccount.findMany({
    where: { provider: "outlook" },
  });

  for (const account of accounts) {
    try {
      const now = new Date();
      if (now < account.expiresAt) continue; // still valid

      console.log(`🔄 Refreshing Outlook token for ${account.email}...`);

      const params = new URLSearchParams({
        client_id: process.env.MS_GRAPH_CLIENT_ID,
        client_secret: process.env.MS_GRAPH_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: account.refreshToken,
      });

      const res = await fetch(
        `https://login.microsoftonline.com/${process.env.MS_GRAPH_TENANT_ID}/oauth2/v2.0/token`,
        { method: "POST", body: params }
      );

      const tokens = await res.json();
      if (!tokens.access_token) {
        console.warn("⚠️ Failed to refresh token for", account.email);
        continue;
      }

      await prisma.calendarAccount.update({
        where: { id: account.id },
        data: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token || account.refreshToken,
          expiresAt: new Date(Date.now() + (tokens.expires_in - 60) * 1000),
        },
      });

      console.log(`✅ Token refreshed successfully for ${account.email}`);
    } catch (err) {
      console.error(`❌ Error refreshing token for ${account.email}:`, err);
    }
  }
}

// Run every 24 hours (Render keeps your dyno hot)
setInterval(refreshOutlookTokens, 24 * 60 * 60 * 1000);


app.use((req, res) => {
  res.status(404).json({ ok: false, error: "NOT_FOUND" });
});

// ---------- Serve Dashboard Frontend ----------
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Serve static files from exported dashboard
app.use(express.static(path.join(__dirname, "public")));

// Catch-all: send index.html for any non-API route
app.get("*", (req, res) => {
  if (req.path.startsWith("/api")) return res.status(404).end();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});



// ---------- Export app for unified server ----------
export default app;

// ---------- Start server if run directly ----------
if (process.env.NODE_ENV === "production" || process.env.NODE_ENV === "development") {
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => {
    console.log(`✅ Ava backend listening on port ${PORT}`);
    console.log(`🌐 Domain: https://api.cubbylockers.com`);
  });
}
