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
import { ensureValidOutlookToken } from "./routes/outlook-sync.js";


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

// Basic rate limiting to protect from spam / brute force
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200,                 // per IP
  })
);

// --- Strict CORS setup (with wildcard support for Vercel previews) ---
const allowedOrigins = [
  "https://dashboard.cubbylockers.com",      // ✅ production dashboard
  "https://aivoice-rental.digitalocean.com", // ✅ temp backend
  "http://localhost:3000",                   // ✅ local dev
  "https://app.aivoicerental.com",
  "https://www.aivoicerental.com",
  /\.vercel\.app$/,                          // ✅ allow any Vercel preview domain
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true); // Allow server-to-server (no origin)

      // ✅ Allow exact matches or regex matches (for *.vercel.app)
      const isAllowed = allowedOrigins.some((allowed) =>
        allowed instanceof RegExp ? allowed.test(origin) : allowed === origin
      );

      if (isAllowed) {
        return callback(null, true);
      } else {
        console.warn("❌ Blocked by CORS:", origin);
        return callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  })
);

import analyticsRouter from "./routes/analytics.js";
app.use("/api/analytics", analyticsRouter);

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

// 🧠 Debug route — check that environment variables are loaded correctly
app.get("/debug/outlook-secret", (req, res) => {
  res.json({
    clientId: process.env.AZURE_CLIENT_ID,
    secretLength: process.env.AZURE_CLIENT_SECRET
      ? process.env.AZURE_CLIENT_SECRET.length
      : 0,
    startsWith: process.env.AZURE_CLIENT_SECRET
      ? process.env.AZURE_CLIENT_SECRET.substring(0, 5)
      : null,
    redirect: process.env.AZURE_REDIRECT_URI,
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
  if (!property) return "No property data available.";

  const f = property.facts || {};
  const lines = [];

  // Mapping of field keys → readable labels
  const LABELS = {
    buildingName: "Building Name",
    address: "Address",
    buildingType: "Building Type",
    unitType: "Unit Type",
    rent: "Rent",
    deposit: "Deposit",
    leaseTerm: "Lease Term",
    leaseType: "Lease Type",
    bedrooms: "Bedrooms",
    bathrooms: "Bathrooms",
    sqft: "Size (sqft)",
    parking: "Parking",
    parkingOptions: "Parking Options",
    utilities: "Utilities",
    includedUtilities: "Included Utilities",
    petsAllowed: "Pets Allowed",
    petPolicy: "Pet Policy",
    furnished: "Furnished",
    availability: "Availability",
    notes: "Notes",
    floorPlans: "Floor Plans",
    amenities: "Amenities",
    managedBy: "Managed By",
    listingUrl: "Listing URL",
    description: "Description",
  };

  for (const [key, val] of Object.entries(f)) {
    if (val == null || val === "") continue;

    const label = LABELS[key] || key.replace(/([A-Z])/g, " $1"); // auto format unknown keys
    let display = val;

    // 🧠 Nice formatting for booleans, JSON, and arrays
    if (typeof val === "boolean") display = val ? "Yes" : "No";
    else if (typeof val === "object") display = JSON.stringify(val, null, 2);

    lines.push(`${label}: ${display}`);
  }

  // Fallback: also include the base property address if not in facts
  if (!f.address && property.address) {
    lines.unshift(`Address: ${property.address}`);
  }

  return `
PROPERTY FACTS (auto-generated context):

${lines.join("\n")}

These are verified facts entered by your team — Ava can confidently refer to them in conversation.
If a renter asks about something not listed here, she’ll politely say she’ll check or confirm.
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

    // 🔍 Find or create the property in DB (auto-create if missing)
    let propertyRecord = await prisma.property.findUnique({
      where: { slug: propSlug },
    });

    if (!propertyRecord) {
      propertyRecord = await prisma.property.create({
        data: { slug: propSlug, address: property },
      });
      console.log(`🏗️ Auto-created property: ${propSlug}`);
    }

    // ✅ Link this lead to the property
    await linkLeadToProperty(lead.id, propertyRecord.id);

    // ✅ Save the initial inbound message from renter
    if (message) {
      await saveMessage({
        phone,
        role: "user",  // ✅ renter’s message
        content: message,
        propertyId: propertyRecord.id,
      });
    }

    // ✅ Ava sends a natural friendly first text
    const initialText = `Hi ${leadName || "there"}! Thanks for your interest in ${propertyRecord.address}. When would you like to come for a showing?`;

    await sendSms(phone, initialText);
    console.log(`📤 Sent intro SMS to ${phone}: "${initialText}"`);

    res.json({ ok: true, linked: true, smsSent: true });
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

// ✅ ADD THIS JUST BELOW THE PROPERTY EDITOR ROUTES
app.get("/debug/facts/:slug", async (req, res) => {
  try {
    const slug = req.params.slug;
    const property = await prisma.property.findUnique({
      where: { slug },
      include: { facts: true },
    });

    if (!property) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    const context = buildContextFromProperty(property);
    res.setHeader("Content-Type", "text/plain");
    res.send(context);
  } catch (err) {
    console.error("❌ /debug/facts failed:", err);
    res.status(500).json({ ok: false, error: "SERVER_ERROR" });
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
      include: {
        lead: true,
        property: true,
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    // Group by phone + property slug so each property thread is unique
    const convMap = {};

    for (const m of messages) {
      const phone = m.lead?.phone || "unknown";
      const slug = m.property?.slug || "unassigned";
      const convId = `${phone}-${slug}`; // ✅ unique ID for frontend

      if (!convMap[convId]) {
        convMap[convId] = {
          id: convId,
          phone,
          leadName: m.lead?.name || phone,
          propertySlug: slug,
          propertyAddress: m.property?.address || null,
          lastMessage: m.content,
          lastTime: m.createdAt,
        };
      }
    }

    const conversations = Object.values(convMap);
    res.json({ ok: true, data: conversations });
  } catch (err) {
    console.error("GET /api/conversations failed:", err);
    res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

// ✅ Alias route: /history/:phone → same as /api/conversations/:phone
app.get("/history/:phone", async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    console.log("🕓 [History] Fetching messages for:", phone);

    const lead = await prisma.lead.findUnique({
      where: { phone },
      include: {
        messages: {
          include: { property: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!lead) {
      console.warn("⚠️ No lead found for", phone);
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    res.json({
      ok: true,
      id: phone,
      lead: { name: lead.name || phone, phone },
      messages: (lead.messages || []).map((m) => ({
        text: m.content || m.text || "",
        sender: m.role === "assistant" ? "ai" : "user",
        createdAt: m.createdAt ? new Date(m.createdAt).toISOString() : null,
        propertySlug: m.property?.slug || null,
      })),
    });
  } catch (err) {
    console.error("❌ GET /history/:phone failed:", err.message, err.stack);
    res.status(500).json({ ok: false, error: err.message || "SERVER_ERROR" });
  }
});


// 🧩 Fetch full message thread for a phone number
app.get("/api/conversations/:phone", async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    console.log("📞 [Conversations] Fetching messages for:", phone);

    const lead = await prisma.lead.findUnique({
      where: { phone },
      include: {
        messages: {
          include: { property: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!lead) {
      console.warn("⚠️ No lead found for", phone);
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    // 🔍 DEBUG: log exactly what Prisma returned
    console.log(
      "📤 Raw Prisma messages:",
      JSON.stringify(lead.messages, null, 2)
    );

    // ✅ Normalize messages to always include correct keys
    const normalizedMessages = (lead.messages || []).map((m) => {
      const text =
        m.content ??
        m.text ??
        m.body ??
        m.message ??
        "(no text found)";
      const created =
        m.createdAt ?? m.timestamp ?? m.time ?? null;

      return {
        text: text,
        sender: m.role === "assistant" ? "ai" : "user",
        createdAt: created ? new Date(created).toISOString() : null,
        propertySlug: m.property?.slug || null,
      };
    });

    // ✅ Respond in the correct shape for frontend
    res.json({
      ok: true,
      id: phone,
      lead: { name: lead.name || phone, phone },
      messages: normalizedMessages,
    });
  } catch (err) {
    console.error(
      "❌ GET /api/conversations/:phone failed:",
      err.message,
      err.stack
    );
    res.status(500).json({ ok: false, error: err.message || "SERVER_ERROR" });
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

    const property = await prisma.property.upsert({
      where: { slug },
      update: { address },
      create: { slug, address },
    });

    console.log("💾 [PropertyEditor] Updating facts for:", slug);

    // 🧠 Only include keys that are actually provided (non-undefined)
    const cleanData = {};
    for (const [key, val] of Object.entries(facts)) {
      if (val !== undefined) cleanData[key] = val;
    }

    // Normalize utilities key for backward compatibility
    if (cleanData.utilitiesIncluded && !cleanData.includedUtilities) {
      cleanData.includedUtilities = cleanData.utilitiesIncluded;
    }
    delete cleanData.utilitiesIncluded;

    cleanData.updatedAt = new Date();
    cleanData.address = cleanData.address ?? address;

    // ✅ Create or update
    const existing = await prisma.propertyFacts.findUnique({
      where: { propertyId: property.id },
    });

    const updatedFacts = existing
      ? await prisma.propertyFacts.update({
          where: { propertyId: property.id },
          data: cleanData,
        })
      : await prisma.propertyFacts.create({
          data: { ...cleanData, propertyId: property.id, slug },
        });

    console.log("✅ [PropertyEditor] Facts saved for:", slug);
    res.json({ ok: true, data: updatedFacts });
  } catch (err) {
    console.error("❌ [PropertyEditor] Failed to update:", err);
    res.status(500).json({ ok: false, error: err.message || "SERVER_ERROR" });
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
    // 🧩 STEP 1 — Log full webhook body
    console.log("📩 [Twilio] Incoming webhook:", JSON.stringify(req.body, null, 2));

    const from = normalizePhone(req.body.From);
    const incomingText = (req.body.Body || "").trim();

    // 🧩 STEP 2 — Log who and what
    console.log(`💬 Message received from ${from}: "${incomingText}"`);

    if (!from || !incomingText) return res.status(400).end();


    // Find or create lead
    const lead = await upsertLeadByPhone(from);


    // Choose property for this lead
let property = await findBestPropertyForLeadFromDB(from);
    console.log("🏠 Property linked to lead:", property?.slug || "none");



// 🔍 Fallback: if lead isn’t linked yet, try to detect from message text
if (!property) {
  property = await findPropertyFromMessage(incomingText);
}

// 🧩 Log which property Ava is using
console.log("🧩 Using property for", from, "→", property?.slug || "none");


    // If no property linked yet but message mentions an address-like snippet, you could:
    // - parse and link here (omitted for V7 minimalism)

    const intent = await detectIntent(incomingText);
console.log("🧠 Detected intent:", intent);

// =======================================================
// 🔄 RESCHEDULE FLOW — if renter asks to move existing booking
// =======================================================
const wantsReschedule = /\b(reschedule|move|change|later|earlier|push|bump|different time|another time|can we do)\b/i.test(incomingText);

if (wantsReschedule) {
  const existingBooking = await prisma.booking.findFirst({
    where: {
      leadId: lead.id,
      datetime: { gte: new Date() },
      status: "confirmed",
    },
    orderBy: { datetime: "asc" },
    include: { property: true },
  });

  if (existingBooking) {
    console.log("🔄 Renter wants to reschedule:", existingBooking.id);

    const parsed = incomingText.match(/\b(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?\b/i);
    if (!parsed) {
      await sendSms(from, "Sure — what new time were you thinking?");
      return res.status(200).end();
    }

    let hour = parseInt(parsed[1], 10);
    const minute = parseInt(parsed[2] || "0", 10);
    let meridian = (parsed[3] || "").toLowerCase();
    if (!meridian && hour >= 1 && hour <= 6) meridian = "pm";
    if (meridian === "pm" && hour < 12) hour += 12;
    if (meridian === "am" && hour === 12) hour = 0;

    const { DateTime } = await import("luxon");
const tz = "America/Edmonton";

// 🧠 Use the *same date* as the existing booking, just change the time
const currentStart = DateTime.fromJSDate(existingBooking.datetime).setZone(tz);

// Apply new hour/minute but keep same day
let newStart = currentStart.set({ hour, minute, second: 0, millisecond: 0 });

// If renter accidentally says a time that's already passed today,
// bump it by 1 day (safety catch)
if (newStart <= DateTime.now().setZone(tz)) {
  newStart = newStart.plus({ days: 1 });
}

const newEnd = newStart.plus({ minutes: 30 });


    // ✅ Check availability
    const availabilityContext = await getAvailabilityContext(existingBooking.propertyId);
    const isBlocked = availabilityContext.blockedSlots.some((b) => {
      const start = DateTime.fromISO(b.start, { zone: tz });
      const end = DateTime.fromISO(b.end, { zone: tz });
      return DateTime.fromJSDate(newStart) >= start && DateTime.fromJSDate(newStart) < end;
    });

    if (isBlocked) {
      const nextSlots = await findNextAvailableSlots(existingBooking.propertyId, newStart, 2);
      await sendSms(from, await generateAvaResponse("slot_taken", { nextSlots }));
      return res.status(200).end();
    }

    // 🗑️ Delete old Outlook event if exists
    if (existingBooking.outlookEventId) {
      try {
        const token = await ensureValidOutlookToken(); // imported from outlook-sync
        await fetch(`https://graph.microsoft.com/v1.0/me/events/${existingBooking.outlookEventId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
        console.log(`🗑️ Deleted old Outlook event ${existingBooking.outlookEventId}`);
      } catch (err) {
        console.warn("⚠️ Failed to delete old Outlook event:", err.message);
      }
    }

    // 🆕 Create new Outlook event
    try {
      if (!newStart.isValid) {
  console.error("❌ Invalid newStart DateTime:", newStart.invalidReason);
  await sendSms(from, "Sorry — that time didn’t parse. Could you rephrase (e.g., '1:00pm')?");
  return res.status(200).end();
}

      const reschedulePayload = {
  subject: `Showing — ${existingBooking.property?.facts?.buildingName || existingBooking.property?.address}`,
  startTime: newStart.toISO(),  // ✅ fixed
  endTime: newEnd.toISO(),      // ✅ fixed
  location: existingBooking.property?.address || "TBD",
  leadEmail: "renter@example.com",
};

      const url = `${process.env.NEXT_PUBLIC_AI_BACKEND_URL}/api/outlook-sync/create-event`;
      const createRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reschedulePayload),
      });
      const data = await createRes.json();

      await prisma.booking.update({
        where: { id: existingBooking.id },
        data: {
          datetime: newStart,
          outlookEventId: data.event?.id || null,
          notes: "Rescheduled via SMS",
        },
      });

      const newTimeStr = DateTime.fromJSDate(newStart).toFormat("ccc, LLL d 'at' h:mm a");
      await sendSms(from, `Got it — I’ve moved your showing to ${newTimeStr}. See you then!`);
      console.log(`🔁 Booking ${existingBooking.id} moved to ${newTimeStr}`);
      return res.status(200).end();
    } catch (err) {
      console.error("❌ Reschedule failed:", err);
      await sendSms(from, "Sorry — I couldn’t update your showing just now. Can you try again?");
      return res.status(200).end();
    }
  }
}



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

// 🗣️ Handle casual phrases like “evening” or “after dinner”
if (/evening/i.test(incomingText)) incomingText += " 7pm";
else if (/afternoon/i.test(incomingText)) incomingText += " 2pm";
else if (/morning/i.test(incomingText)) incomingText += " 10am";
else if (/lunch/i.test(incomingText)) incomingText += " 12pm";
else if (/dinner/i.test(incomingText)) incomingText += " 6pm";

// 🧠 If renter says “same time” or “that works”, reuse last booking time
const lastBooking = await prisma.booking.findFirst({
  where: { leadId: lead.id },
  orderBy: { createdAt: "desc" },
});
if (/same time|that works|let's do it/i.test(incomingText) && lastBooking) {
  const prev = DateTime.fromJSDate(lastBooking.datetime).setZone(tz);
  incomingText += " " + prev.toFormat("h:mma");
}

// 🧠 Smart time parser with common-sense defaults
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
let meridian = (match[4] || "").toLowerCase();

// 🧩 If no AM/PM, guess based on realistic showing hours
if (!meridian) {
  if (hour >= 7 && hour <= 11) meridian = "am";
  else meridian = "pm";
}

// 🕑 Convert to 24h time
if (meridian === "pm" && hour < 12) hour += 12;
if (meridian === "am" && hour === 12) hour = 0;

// 📅 Build target date
let date = now;
if (weekday) {
  const target = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(
    weekday.slice(0, 3)
  );
  const diff = (target - date.weekday + 7) % 7 || 7;
  date = date.plus({ days: diff });
} else if (incomingText.toLowerCase().includes("tomorrow")) {
  date = date.plus({ days: 1 });
}

const requestedStart = date
  .set({ hour, minute, second: 0, millisecond: 0 })
  .toJSDate();

const availabilityContext = await getAvailabilityContext(property?.id);
const { blockedSlots } = availabilityContext;
const requestedDT = DateTime.fromJSDate(requestedStart).setZone(tz);

// ⛔ Prevent bookings in the past
if (requestedDT <= DateTime.now().setZone(tz)) {
  await sendSms(from, await generateAvaResponse("past_time"));
  return res.status(200).end();
}

// 🔍 Check blocked slots
const isBlocked = blockedSlots.some((b) => {
  const bStart = DateTime.fromISO(b.start, { zone: tz });
  const bEnd = DateTime.fromISO(b.end, { zone: tz });
  return requestedDT >= bStart && requestedDT < bEnd;
});

console.log("[BOOKING CHECK]", requestedDT.toISO(), "blockedSlots:", blockedSlots.length);

// 🧩 Case 1: Slot already blocked
if (isBlocked) {
  const nextSlots = await findNextAvailableSlots(property.id, requestedStart, 2);
  if (nextSlots.length) {
    await sendSms(from, await generateAvaResponse("slot_taken", { nextSlots }));
  } else {
    await sendSms(from, await generateAvaResponse("no_slots"));
  }
  return res.status(200).end();
}

// 🛑 Case 2: Lead already booked same time
const existing = await prisma.booking.findFirst({
  where: {
    lead: { phone: from },
    datetime: requestedDT,
  },
});

if (existing) {
  console.log(`⚠️ Skipping duplicate booking for ${from} at ${requestedDT}`);

  const existingTime = DateTime.fromJSDate(existing.datetime)
    .setZone(tz)
    .toFormat("ccc, LLL d 'at' h:mm a");

  await sendSms(
    from,
    await generateAvaResponse("duplicate_booking", { existingTime })
  );

  return res.status(200).end();
}

// ✅ Case 3: Create new booking
let booking;
try {
  booking = await prisma.booking.create({
    data: {
      leadId: lead.id,
      propertyId: property.id,
      datetime: requestedStart,
      status: "confirmed",
    },
  });
} catch (err) {
  if (err.code === "P2002") {
    console.warn("⚠️ Duplicate booking prevented by unique constraint:", {
      propertyId: property.id,
      datetime: requestedStart,
    });
    await sendSms(
      from,
      await generateAvaResponse("slot_taken", { nextSlots: [] })
    );
    return res.status(200).end();
  }
  throw err;
}

const startFmt = requestedDT.toFormat("ccc, LLL d 'at' h:mm a");
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
    console.log("🧠 Generating AI reply...");
const reply = await aiReply({
  incomingText,
  property,
  intent,
  availabilityContext,
});
    console.log("🤖 AI reply generated:", reply);



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
        client_id: process.env.AZURE_CLIENT_ID,
        client_secret: process.env.AZURE_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: account.refreshToken,
        redirect_uri: process.env.AZURE_REDIRECT_URI,
      });

      const res = await fetch(
        `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
        { method: "POST", body: params }
      );

      const tokens = await res.json();
      if (!tokens.access_token) {
        console.warn("⚠️ Failed to refresh token for", account.email, tokens);
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



// ✅ Serve all static files (CSS, JS, etc.) from ./ai-backend/public
app.use(express.static(path.join(__dirname, "public")));

// ✅ For any non-API route (like /dashboard, /properties, /bookings)
// send back the React app’s index.html so the static dashboard can handle routing
app.get(/^(?!\/api).*/, (req, res) => {
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
