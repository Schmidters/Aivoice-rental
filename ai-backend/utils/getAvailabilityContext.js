// ai-backend/utils/getAvailabilityContext.js
import { PrismaClient } from "@prisma/client";
import { DateTime } from "luxon";
import fetch from "node-fetch";

const prisma = new PrismaClient();

/**
 * getAvailabilityContext()
 * - Merges internal DB availability + Outlook events
 * - Returns unified context with available + blocked slots
 */
export async function getAvailabilityContext(propertyId = null) {
  try {
    const BACKEND = process.env.DASHBOARD_ORIGIN;

    // 1️⃣ Global office/showing hours (if stored)
    const global = await prisma.globalSettings.findFirst();

    // 2️⃣ Fetch DB-defined slots (available + blocked)
    const availability = await prisma.availability.findMany({
      where: propertyId ? { propertyId, isBlocked: false } : { isBlocked: false },
      select: { startTime: true, endTime: true },
    });

    const blocked = await prisma.availability.findMany({
      where: propertyId ? { propertyId, isBlocked: true } : { isBlocked: true },
      select: { startTime: true, endTime: true },
    });

    // 3️⃣ Fetch Outlook events (live calendar busy times)
    const outlookRes = await fetch(`${BACKEND}/api/outlook-sync/events`);
    const outlookJson = await outlookRes.json();
    const outlookBusy = (outlookJson.data || []).map((e) => ({
      start: DateTime.fromISO(e.start).toISO(),
      end: DateTime.fromISO(e.end).toISO(),
    }));

    // 4️⃣ Merge DB + Outlook busy periods
    const blockedSlots = [
      ...blocked.map((a) => ({
        start: DateTime.fromJSDate(a.startTime).toISO(),
        end: DateTime.fromJSDate(a.endTime).toISO(),
      })),
      ...outlookBusy,
    ];

    // 5️⃣ Return unified context
    return {
      globalHours: global || {},
      availableSlots: availability.map((a) => ({
        start: DateTime.fromJSDate(a.startTime).toISO(),
        end: DateTime.fromJSDate(a.endTime).toISO(),
      })),
      blockedSlots,
    };
  } catch (err) {
    console.error("❌ getAvailabilityContext failed:", err);
    return {
      globalHours: {},
      availableSlots: [],
      blockedSlots: [],
    };
  }
}
