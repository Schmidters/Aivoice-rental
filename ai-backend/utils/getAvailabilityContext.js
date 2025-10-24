// ai-backend/utils/getAvailabilityContext.js
import { PrismaClient } from "@prisma/client";
import { DateTime } from "luxon";
import fetch from "node-fetch";

const prisma = new PrismaClient();

/**
 * getAvailabilityContext()
 * - Returns unified context for AI to understand open vs busy slots
 * - Merges: GlobalSettings + DB Availability + live Outlook events
 * - Includes 1-second retry on Outlook rate limits (HTTP 429)
 */
export async function getAvailabilityContext(propertyId = null) {
  try {
    const BACKEND =
      process.env.NEXT_PUBLIC_AI_BACKEND_URL ||
      process.env.DASHBOARD_ORIGIN ||
      "https://aivoice-rental.onrender.com";

    // 1️⃣ Global showing hours
    const global = await prisma.globalSettings.findFirst();

    // 2️⃣ Fetch all DB availability for the property (blocked + free)
    const availability = await prisma.availability.findMany({
      where: propertyId ? { propertyId } : {},
      orderBy: { startTime: "asc" },
      select: {
        startTime: true,
        endTime: true,
        isBlocked: true,
        notes: true,
      },
    });

    // 3️⃣ Fetch Outlook events (with safe retry on 429)
    let outlookBusy = [];
    try {
      const fetchOutlook = async () => {
        const res = await fetch(`${BACKEND}/api/outlook-sync/events`);
        if (res.status === 429) {
          console.warn("⚠️ Outlook API rate-limited (429). Retrying in 1s...");
          await new Promise((r) => setTimeout(r, 1000));
          return fetch(`${BACKEND}/api/outlook-sync/events`);
        }
        return res;
      };

      const outlookRes = await fetchOutlook();
      const outlookJson = await outlookRes.json();

      if (outlookJson?.data?.length) {
        outlookBusy = outlookJson.data
          .filter((e) => e.showAs?.toLowerCase() === "busy")
          .map((e) => ({
            start: DateTime.fromISO(e.start).toISO(),
            end: DateTime.fromISO(e.end).toISO(),
            notes: e.title || "Outlook Busy",
          }));
      }
    } catch (err) {
      console.warn("⚠️ Skipping Outlook merge (fetch failed):", err.message);
    }

    // 4️⃣ Split available vs blocked DB entries
    const blockedSlots = [
      ...availability
        .filter((a) => a.isBlocked)
        .map((a) => ({
          start: DateTime.fromJSDate(a.startTime).toISO(),
          end: DateTime.fromJSDate(a.endTime).toISO(),
          notes: a.notes || "Busy",
        })),
      ...outlookBusy,
    ];

    const availableSlots = availability
      .filter((a) => !a.isBlocked)
      .map((a) => ({
        start: DateTime.fromJSDate(a.startTime).toISO(),
        end: DateTime.fromJSDate(a.endTime).toISO(),
        notes: a.notes || "Free",
      }));

    // 5️⃣ Return clean context for Ava
    return {
      globalHours: {
        openStart: global?.openStart || "08:00",
        openEnd: global?.openEnd || "17:00",
        saturdayStart: global?.saturdayStart || "10:00",
        saturdayEnd: global?.saturdayEnd || "14:00",
      },
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
