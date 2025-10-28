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

    // 💬 Active conversations (unique phone numbers from recent messages)
    const recentMessages = await prisma.message.findMany({
  where: { createdAt: { gte: sevenDaysAgo } },
  select: { lead: { select: { phone: true } } }, // ✅ pull phone from related Lead
});

const uniquePhones = new Set(
  recentMessages.map((m) => m.lead?.phone).filter(Boolean)
);

    const activeConversations = uniquePhones.size;

    // 🏠 Showings booked (confirmed bookings)
    const showingsBooked = await prisma.booking.count({
      where: { status: "confirmed" },
    });

    // 📈 Booking rate
    const bookingRate =
      leadsThisMonth > 0
        ? Math.round((showingsBooked / leadsThisMonth) * 100)
        : 0;

    // 📊 7-day leads vs bookings chart
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

    const properties = await prisma.propertyFacts.count();

    res.json({
      ok: true,
      data: {
        leadsThisMonth,
        activeConversations,
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
