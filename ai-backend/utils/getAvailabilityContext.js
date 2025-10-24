// ai-backend/utils/getAvailabilityContext.js
import { PrismaClient } from "@prisma/client";
import { DateTime } from "luxon";
import fetch from "node-fetch";

const prisma = new PrismaClient();

/**
 * getAvailabilityContext()
 * - Combines DB + Outlook data
 * - Normalizes all times to local timezone
 */
export async function getAvailabilityContext(propertyId = null) {
  const tz = "America/Edmonton";

  try {
    const BACKEND =
      process.env.NEXT_PUBLIC_AI_BACKEND_URL ||
      "https://aivoice-rental.onrender.com";

    // 1️⃣ Get global showing hours
    const global = await prisma.globalSettings.findFirst();

    // 2️⃣ Fetch DB-defined slots (normalize to local)
    const availability = await prisma.availability.findMany({
      where: propertyId ? { propertyId } : {},
      select: { startTime: true, endTime: true, isBlocked: true },
    });

    // Normalize all DB times to local zone
    const availableSlots = availability
      .filter((a) => !a.isBlocked)
      .map((a) => ({
        start: DateTime.fromJSDate(a.startTime).setZone(tz).toISO(),
        end: DateTime.fromJSDate(a.endTime).setZone(tz).toISO(),
      }));

    const blockedFromDB = availability
      .filter((a) => a.isBlocked)
      .map((a) => ({
        start: DateTime.fromJSDate(a.startTime).setZone(tz).toISO(),
        end: DateTime.fromJSDate(a.endTime).setZone(tz).toISO(),
      }));

    // 3️⃣ Fetch Outlook events (normalize to same tz)
    let outlookBusy = [];
    try {
      const outlookRes = await fetch(`${BACKEND}/api/outlook-sync/events`);
      const outlookJson = await outlookRes.json();
      outlookBusy = (outlookJson.data || []).map((e) => ({
        start: DateTime.fromISO(e.start, { zone: tz }).toISO(),
        end: DateTime.fromISO(e.end, { zone: tz }).toISO(),
      }));
      console.log(`📅 Outlook busy slots: ${outlookBusy.length}`);
    } catch (err) {
      console.warn("⚠️ Skipping Outlook merge (fetch failed):", err.message);
    }

    // 4️⃣ Merge busy slots
    const blockedSlots = [...blockedFromDB, ...outlookBusy];

    // 5️⃣ Log merged results for visibility
    console.log(
      `🧭 AvailabilityContext → ${blockedSlots.length} busy / ${availableSlots.length} open`
    );

    // 6️⃣ Return unified context
    return {
      globalHours: global || {},
      availableSlots,
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
