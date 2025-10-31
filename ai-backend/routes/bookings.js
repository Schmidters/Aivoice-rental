// ai-backend/routes/bookings.js
import express from "express";
import { PrismaClient } from "@prisma/client";
import { DateTime } from "luxon";

const prisma = new PrismaClient();
const router = express.Router();

// 🧩 Helper — check if requested slot is available
async function isTimeAvailable(propertyId, requestedStart, duration = 30) {
  const requestedEnd = DateTime.fromJSDate(requestedStart).plus({ minutes: duration }).toJSDate();

  // Check for existing bookings that overlap
  const conflicts = await prisma.booking.findMany({
    where: {
      propertyId,
      status: { not: "cancelled" },
      OR: [
        {
          datetime: { lte: requestedEnd },
          // booking end overlaps with requested start
        },
      ],
    },
  });

  // Check availability table
  const blocked = await prisma.availability.findMany({
    where: {
      propertyId,
      isBlocked: true,
      OR: [
        {
          startTime: { lte: requestedEnd },
          endTime: { gte: requestedStart },
        },
      ],
    },
  });

  return conflicts.length === 0 && blocked.length === 0;
}

// 🗓️ GET /api/bookings
router.get("/", async (req, res) => {
  try {
    const bookings = await prisma.booking.findMany({
      include: {
        lead: true,
        property: {
          include: {
            facts: true, // ✅ include property facts for unitType, rent, etc.
          },
        },
      },
      orderBy: { datetime: "asc" },
    });

    res.json({ ok: true, data: bookings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});



// 📅 POST /api/bookings — schedule a showing
// 📅 POST /api/bookings — schedule a showing
router.post("/", async (req, res) => {
  try {
    const { leadPhone, propertySlug, datetime } = req.body;

    if (!leadPhone || !propertySlug || !datetime)
      return res.status(400).json({ ok: false, error: "Missing fields" });

    const lead = await prisma.lead.findUnique({ where: { phone: leadPhone } });
    const property = await prisma.property.findUnique({ where: { slug: propertySlug } });
    if (!lead || !property)
      return res.status(404).json({ ok: false, error: "Lead or property not found" });

    // 🕒 Normalize start time to exact 30-minute slot to prevent duplicate entries
    const requestedStart = new Date(datetime);
    requestedStart.setSeconds(0, 0);

    // 🧩 Check if the requested time is available
    const available = await isTimeAvailable(property.id, requestedStart, 30);
    if (!available) {
      return res.json({
        ok: false,
        conflict: true,
        message: "Requested time is unavailable",
      });
    }

    // 🧠 Create the booking record
    const booking = await prisma.booking.create({
      data: {
        propertyId: property.id,
        leadId: lead.id,
        datetime: requestedStart,
        status: "pending",
        source: "dashboard",
      },
    });

    res.json({ ok: true, data: booking });
  } catch (err) {
    console.error("❌ Booking error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// 🔁 PUT /api/bookings/:id — update booking status
router.put("/:id", async (req, res) => {
  try {
    const { status, notes } = req.body;
    const booking = await prisma.booking.update({
      where: { id: Number(req.params.id) },
      data: { status, notes },
    });
    res.json({ ok: true, data: booking });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
