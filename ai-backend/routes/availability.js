// ai-backend/routes/availability.js
import express from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = express.Router();

// 🔹 In-memory list of SSE clients
const clients = new Set();

/* -------------------------------------------------------------
   📅 GET /api/availability
   Returns global open hours + all availability slots
------------------------------------------------------------- */
router.get("/", async (req, res) => {
  try {
    const { propertySlug } = req.query;
    const where = propertySlug ? { property: { slug: propertySlug } } : undefined;

    const availability = await prisma.availability.findMany({
      where,
      include: { property: true },
      orderBy: { startTime: "asc" },
    });

    // 🧠 Ensure GlobalSettings row exists
    let settings = await prisma.globalSettings.findFirst();
    if (!settings) {
      settings = await prisma.globalSettings.create({
        data: {
          openStart: "08:00",
          openEnd: "17:00",
          mondayStart: "08:00",
          mondayEnd: "17:00",
          tuesdayStart: "08:00",
          tuesdayEnd: "17:00",
          wednesdayStart: "08:00",
          wednesdayEnd: "17:00",
          thursdayStart: "08:00",
          thursdayEnd: "17:00",
          fridayStart: "08:00",
          fridayEnd: "17:00",
          saturdayStart: "10:00",
          saturdayEnd: "14:00",
          sundayStart: "00:00",
          sundayEnd: "00:00",
        },
      });
    }

    res.json({
      ok: true,
      data: {
        openStart: settings.openStart,
        openEnd: settings.openEnd,
        days: {
          monday: { start: settings.mondayStart, end: settings.mondayEnd },
          tuesday: { start: settings.tuesdayStart, end: settings.tuesdayEnd },
          wednesday: { start: settings.wednesdayStart, end: settings.wednesdayEnd },
          thursday: { start: settings.thursdayStart, end: settings.thursdayEnd },
          friday: { start: settings.fridayStart, end: settings.fridayEnd },
          saturday: { start: settings.saturdayStart, end: settings.saturdayEnd },
          sunday: { start: settings.sundayStart, end: settings.sundayEnd },
        },
        slots: availability,
      },
    });
  } catch (err) {
    console.error("❌ GET /api/availability:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* -------------------------------------------------------------
   💾 POST /api/availability
   Updates per-day open hours or adds property availability
------------------------------------------------------------- */
router.post("/", async (req, res) => {
  try {
    const {
      propertySlug,
      startTime,
      endTime,
      isBlocked,
      notes,
      openStart,
      openEnd,
      days,
    } = req.body;

    // 🕒 Case 1: Update global open hours (including per-day)
    if (days || openStart || openEnd) {
      console.log("🕓 [API] Saving global calendar settings:", req.body);

      const updateData = {
        openStart: openStart ?? "08:00",
        openEnd: openEnd ?? "17:00",
        mondayStart: days?.monday?.start ?? "08:00",
        mondayEnd: days?.monday?.end ?? "17:00",
        tuesdayStart: days?.tuesday?.start ?? "08:00",
        tuesdayEnd: days?.tuesday?.end ?? "17:00",
        wednesdayStart: days?.wednesday?.start ?? "08:00",
        wednesdayEnd: days?.wednesday?.end ?? "17:00",
        thursdayStart: days?.thursday?.start ?? "08:00",
        thursdayEnd: days?.thursday?.end ?? "17:00",
        fridayStart: days?.friday?.start ?? "08:00",
        fridayEnd: days?.friday?.end ?? "17:00",
        saturdayStart: days?.saturday?.start ?? "10:00",
        saturdayEnd: days?.saturday?.end ?? "14:00",
        sundayStart: days?.sunday?.start ?? "00:00",
        sundayEnd: days?.sunday?.end ?? "00:00",
        updatedAt: new Date(),
      };

      const settings = await prisma.globalSettings.upsert({
        where: { id: 1 },
        update: updateData,
        create: updateData,
      });

      return res.json({ ok: true, data: settings });
    }

    // 🏘️ Case 2: Create property-level availability slot
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

/* -------------------------------------------------------------
   ❌ DELETE /api/availability/:id
------------------------------------------------------------- */
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const deleted = await prisma.availability.delete({ where: { id } });

    const msg = JSON.stringify({ type: "deleted", data: { id } });
    clients.forEach((res) => res.write(`data: ${msg}\n\n`));

    res.json({ ok: true, data: deleted });
  } catch (err) {
    console.error("❌ DELETE /api/availability/:id:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* -------------------------------------------------------------
   📡 SSE Stream — /api/availability/events
------------------------------------------------------------- */
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
