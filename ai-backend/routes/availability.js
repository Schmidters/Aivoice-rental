// ai-backend/routes/availability.js
import express from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = express.Router();

// GET /api/availability
router.get("/", async (req, res) => {
  try {
    const availability = await prisma.availability.findMany({
      include: { property: true },
      orderBy: { startTime: "asc" },
    });
    res.json({ ok: true, data: availability });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/availability — add new available or blocked slot
router.post("/", async (req, res) => {
  try {
    const { propertySlug, startTime, endTime, isBlocked, notes } = req.body;
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
    res.json({ ok: true, data: slot });
  } catch (err) {
    console.error("❌ Availability error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
