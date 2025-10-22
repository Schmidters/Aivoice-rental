// ai-backend/routes/availability.js
import express from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = express.Router();

// 🔹 In-memory list of SSE clients
const clients = new Set();


// --- GET /api/availability ---
// Returns all availability slots + global open hours
router.get("/", async (req, res) => {
  try {
    const { propertySlug } = req.query;
    const where = propertySlug ? { property: { slug: propertySlug } } : undefined;

    const availability = await prisma.availability.findMany({
      where,
      include: { property: true },
      orderBy: { startTime: "asc" },
    });

    // 🧠 Fetch global open hours (fallback if missing)
    let settings = await prisma.globalSettings.findFirst();
    if (!settings) {
      settings = await prisma.globalSettings.create({
        data: { openStart: "08:00", openEnd: "17:00" },
      });
    }

    res.json({
      ok: true,
      data: {
        openStart: settings.openStart,
        openEnd: settings.openEnd,
        slots: availability,
      },
    });
  } catch (err) {
    console.error("❌ GET /api/availability:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- POST /api/availability ---
// Handles open hour updates + slot creation
router.post("/", async (req, res) => {
  try {
    const { propertySlug, startTime, endTime, isBlocked, notes, openStart, openEnd } = req.body;

    // Case 1: Dashboard "open hours" update
    if (openStart && openEnd && !startTime) {
      console.log("🕒 [API] Persisting open hours:", openStart, openEnd);
      const settings = await prisma.globalSettings.upsert({
        where: { id: 1 },
        update: { openStart, openEnd, updatedAt: new Date() },
        create: { openStart, openEnd },
      });
      return res.json({ ok: true, data: settings });
    }

    // Case 2: Property-level availability slot
    if (!propertySlug) {
      return res.status(400).json({ ok: false, error: "Missing propertySlug" });
    }

    const property = await prisma.property.findUnique({ where: { slug: propertySlug } });
    if (!property) return res.status(404).json({ ok: false, error: "Property not found" });

    const slot = await prisma.availability.create({
      data: {
        propertyId: property.id,
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        isBlocked: isBlocked ?? false,
        notes: notes || null,
      },
    });

    const msg = JSON.stringify({ type: "created", data: slot });
    clients.forEach((res) => res.write(`data: ${msg}\n\n`));

    res.json({ ok: true, data: slot });
  } catch (err) {
    console.error("❌ POST /api/availability:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// --- DELETE /api/availability/:id ---
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const deleted = await prisma.availability.delete({ where: { id } });

    // Broadcast deletion to SSE clients
    const msg = JSON.stringify({ type: "deleted", data: { id } });
    clients.forEach((res) => res.write(`data: ${msg}\n\n`));

    res.json({ ok: true, data: deleted });
  } catch (err) {
    console.error("❌ DELETE /api/availability/:id:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- SSE stream: /api/availability/events ---
router.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  clients.add(res);
  console.log("📡 [SSE] Client connected (availability)");
  req.on("close", () => {
    clients.delete(res);
    console.log("❌ [SSE] Client disconnected (availability)");
  });
});

export default router;
