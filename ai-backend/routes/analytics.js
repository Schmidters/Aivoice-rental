// ai-backend/routes/analytics.js
import express from "express";
import { PrismaClient } from "@prisma/client";

const router = express.Router();
const prisma = new PrismaClient();

router.get("/", async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // 🧮 Leads this month
    const leadsThisMonth = await prisma.lead.count({
      where: { createdAt: { gte: startOfMonth } },
    });

    // 💬 Active conversations (messages in last 7 days)
    const activeConversations = await prisma.message.groupBy({
      by: ["leadPhone"],
      where: { createdAt: { gte: sevenDaysAgo } },
    });

    // 🏠 Showings booked (confirmed bookings)
    const showingsBooked = await prisma.booking.count({
      where: { status: "confirmed" },
    });

    // 🔢 Booking rate
    const bookingRate =
      leadsThisMonth > 0
        ? Math.round((showingsBooked / leadsThisMonth) * 100)
        : 0;

    // 📈 Build 7-day trend (leads & bookings)
    const chart = [];
    for (let i = 6; i >= 0; i--) {
      const dayStart = new Date();
      dayStart.setDate(now.getDate() - i);
      dayStart.setHours(0, 0, 0, 0);

      const dayEnd = new Date(dayStart);
      dayEnd.setHours(23, 59, 59, 999);

      const leads = await prisma.lead.count({
        where: { createdAt: { gte: dayStart, lt: dayEnd } },
      });

      const bookings = await prisma.booking.count({
        where: { createdAt: { gte: dayStart, lt: dayEnd } },
      });

      chart.push({
        day: dayStart.toLocaleDateString("en-US", { weekday: "short" }),
        leads,
        bookings,
      });
    }

    // 🧱 Active properties
    const properties = await prisma.propertyFacts.count();

    res.json({
      ok: true,
      data: {
        leadsThisMonth,
        activeConversations: activeConversations.length,
        showingsBooked,
        bookingRate,
        properties,
        chart,
      },
    });
  } catch (err) {
    console.error("❌ Analytics route failed:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
