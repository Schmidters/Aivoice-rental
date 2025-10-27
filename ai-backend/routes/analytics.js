// ai-backend/routes/analytics.js
import express from "express";
import { PrismaClient } from "@prisma/client";

const router = express.Router();
const prisma = new PrismaClient();

// 📊 Return simple dashboard stats
router.get("/", async (req, res) => {
  try {
    const [leads, bookings, properties] = await Promise.all([
      prisma.lead.count(),
      prisma.booking.count(),
      prisma.propertyFacts.count(),
    ]);
    res.json({ ok: true, data: { leads, bookings, properties } });
  } catch (err) {
    console.error("❌ Analytics route failed:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
