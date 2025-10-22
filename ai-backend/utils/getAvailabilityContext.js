// ai-backend/utils/getAvailabilityContext.js
import { PrismaClient } from "@prisma/client";
import { DateTime } from "luxon";

const prisma = new PrismaClient();

export async function getAvailabilityContext(propertyId = null) {
  const global = await prisma.globalSettings.findFirst();

  const availability = await prisma.availability.findMany({
    where: propertyId ? { propertyId, isBlocked: false } : { isBlocked: false },
    select: { startTime: true, endTime: true },
  });

  const blocked = await prisma.availability.findMany({
    where: propertyId ? { propertyId, isBlocked: true } : { isBlocked: true },
    select: { startTime: true, endTime: true },
  });

  return {
    globalHours: global || {},
    availableSlots: availability.map(a => ({
      start: DateTime.fromJSDate(a.startTime).toISO(),
      end: DateTime.fromJSDate(a.endTime).toISO(),
    })),
    blockedSlots: blocked.map(a => ({
      start: DateTime.fromJSDate(a.startTime).toISO(),
      end: DateTime.fromJSDate(a.endTime).toISO(),
    })),
  };
}
