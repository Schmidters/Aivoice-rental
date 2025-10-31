// ai-backend/routes/outlook-sync.js
import express from "express";
import fetch from "node-fetch";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = express.Router();

/**
 * 🧠 Helper: Ensure Outlook access token is valid (auto-refresh if expired)
 */
async function ensureValidOutlookToken() {
  const account = await prisma.calendarAccount.findFirst({
    where: { provider: "outlook" },
  });
  if (!account) throw new Error("No Outlook account connected");

  const expiresAt = new Date(account.expiresAt || 0).getTime();
  const now = Date.now();

  // 🕒 Refresh 5 minutes early
  if (expiresAt > now + 5 * 60 * 1000) {
    return account.accessToken;
  }

  console.log("🔄 Refreshing Outlook access token...");

const clientId = process.env.AZURE_CLIENT_ID;
const clientSecret = process.env.AZURE_CLIENT_SECRET;
const redirectUri = process.env.AZURE_REDIRECT_URI;
const tenantId = process.env.AZURE_TENANT_ID || "common";


console.log("🧭 Outlook Token Refresh Config:", {
  tenantId,
  redirectUri,
  hasClientId: !!clientId,
  hasClientSecret: !!clientSecret,
});


  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
    redirect_uri: redirectUri,
  });

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });


  const json = await res.json();
  if (!json.access_token) {
    console.error("❌ Outlook token refresh failed:", JSON.stringify(json, null, 2));
    throw new Error(json.error_description || "Outlook token refresh failed");
  }

  // 💾 Save new tokens
  await prisma.calendarAccount.update({
    where: { id: account.id },
    data: {
      accessToken: json.access_token,
      refreshToken: json.refresh_token || account.refreshToken,
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
    },
  });

  // 👀 Add this log for visibility
  const nextExpiry = new Date(Date.now() + json.expires_in * 1000).toLocaleString("en-CA", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  console.log(`✅ Outlook token refreshed. Next expiry at: ${nextExpiry}`);

  return json.access_token;
}


/**
 * 🔹 1. GET /api/outlook-sync/events
 * Returns all Outlook calendar events (including Busy blocks)
 */
router.get("/events", async (req, res) => {
  try {
    const accessToken = await ensureValidOutlookToken();

    const now = new Date().toISOString();
    const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const graphUrl = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${now}&endDateTime=${nextWeek}&$select=id,subject,start,end,location,showAs`;
    const graphRes = await fetch(graphUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'outlook.timezone="America/Edmonton"',
      },
    });

    const data = await graphRes.json();
    if (data.error) {
      console.error("⚠️ Outlook Graph API Error:", data.error);
      return res.status(400).json({ ok: false, error: data.error.message });
    }

    const events = (data.value || []).map((e) => ({
      id: e.id,
      title: e.subject || "Busy",
      start: e.start?.dateTime,
      end: e.end?.dateTime,
      location: e.location?.displayName || "",
      showAs: e.showAs || "busy",
      source: "Outlook",
    }));

    res.json({ ok: true, data: events });
  } catch (err) {
    console.error("❌ /api/outlook-sync/events failed:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * 🔹 2. POST /api/outlook-sync/subscribe
 */
router.post("/subscribe", async (req, res) => {
  try {
    const accessToken = await ensureValidOutlookToken();

    const calRes = await fetch("https://graph.microsoft.com/v1.0/me/calendars", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const calData = await calRes.json();
    const calendars = calData.value || [];

    const subs = [];
    for (const cal of calendars) {
      const payload = {
        changeType: "created,updated,deleted",
        notificationUrl: `${process.env.NEXT_PUBLIC_AI_BACKEND_URL}/api/outlook-sync/webhook`,
        resource: `/me/calendars/${cal.id}/events`,
        expirationDateTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        clientState: "secure-verifier",
      };

      const subRes = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      subs.push(await subRes.json());
    }

    res.json({ ok: true, subs });
  } catch (err) {
    console.error("❌ Outlook Subscribe Error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * 🔹 3. POST /api/outlook-sync/webhook
 */
router.post("/webhook", async (req, res) => {
  if (req.query.validationToken) {
    return res.status(200).send(req.query.validationToken);
  }
  const notifications = req.body.value || [];
  for (const note of notifications) {
    console.log("📬 Received Outlook webhook:", note);
  }
  res.sendStatus(202);
});

/**
 * 🔹 4. GET /api/outlook-sync/poll
 * Pulls Outlook events and syncs them into Availability
 */
router.get("/poll", async (req, res) => {
  try {
    const accessToken = await ensureValidOutlookToken();

    const start = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${start}&endDateTime=${end}&$select=id,subject,start,end,showAs`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'outlook.timezone="America/Edmonton"',
      },
    });

    const json = await resp.json();
    if (!json.value) throw new Error("Invalid Graph response");

    // 🧹 Clear old availability (past events)
    await prisma.availability.deleteMany({
      where: { endTime: { lt: new Date() } },
    });

    // 🧠 Insert only valid busy events
    let count = 0;
    for (const e of json.value) {
      // Skip non-busy events
      if (e.showAs && e.showAs.toLowerCase() !== "busy") continue;

      // 🧩 Sync Outlook event deletions (if user removed from calendar)
const existingBookings = await prisma.booking.findMany({
  where: { outlookEventId: { not: null } },
});

for (const b of existingBookings) {
  const stillExists = json.value.some((e) => e.id === b.outlookEventId);
  if (!stillExists) {
    await prisma.booking.update({
      where: { id: b.id },
      data: { status: "cancelled" },
    });
    console.log(`🗑️ Booking ${b.id} marked cancelled — Outlook event removed`);
  }
}

      // Skip malformed events
      if (!e.start?.dateTime || !e.end?.dateTime) continue;

      const startTime = new Date(e.start.dateTime);
      startTime.setSeconds(0, 0);
      const endTime = new Date(e.end.dateTime);

      // Skip long or multi-day events (>12h)
      const durationHours = (endTime - startTime) / (1000 * 60 * 60);
      if (durationHours > 12) continue;

      // Try to match Outlook event to a property
      let propertyId = 1;
      try {
        const property = await prisma.property.findFirst({
          where: {
            OR: [
              { address: { contains: e.subject, mode: "insensitive" } },
              { slug: { contains: e.subject.toLowerCase().replace(/\s+/g, "-") } },
            ],
          },
        });
        if (property) propertyId = property.id;
      } catch (err) {
        console.warn("⚠️ Could not match property:", err.message);
      }

      // 🧠 Try to match by Outlook Event ID or start time
// 🧠 Smarter duplicate check — avoids creating a duplicate booking
const existingBooking = await prisma.booking.findFirst({
  where: {
    OR: [
      { outlookEventId: e.id },
      {
        datetime: startTime,
        propertyId,
        // ✅ only treat as duplicate if it's confirmed (not cancelled)
        status: { in: ["confirmed", "pending"] },
      },
    ],
  },
});

// 🧠 Smarter sync — upsert Booking & Availability together
await prisma.booking.upsert({
  where: {
    propertyId_datetime: {
      propertyId,
      datetime: startTime,
    },
  },
  update: {
    outlookEventId: e.id,
    status: "confirmed",
    notes: e.subject || "Showing synced from Outlook",
    source: "Outlook",
  },
  create: {
    propertyId,
    datetime: startTime,
    status: "confirmed",
    notes: e.subject || "Showing synced from Outlook",
    outlookEventId: e.id,
    source: "Outlook",
    leadId: (
      await prisma.lead.findFirst({
        where: { phone: "+10000000000" },
      }) || (await prisma.lead.create({
        data: { name: "Outlook Calendar", phone: "+10000000000" },
      }))
    ).id,
  },
});

// ✅ Maintain availability (block busy times)
await prisma.availability.upsert({
  where: {
    propertyId_startTime: {
      propertyId,
      startTime,
    },
  },
  update: {
    endTime,
    isBlocked: true,
    notes: e.subject || "Busy",
  },
  create: {
    propertyId,
    startTime,
    endTime,
    isBlocked: true,
    notes: e.subject || "Busy",
  },
});

console.log(`✅ Synced Outlook event → Booking (${propertyId}, ${startTime.toISOString()})`);
count++;

    }

    res.json({ ok: true, synced: count });
  } catch (err) {
    console.error("❌ Outlook Poll Error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});


/**
 * 🔹 5. POST /api/outlook-sync/create-event
 * Create a new Outlook calendar event
 */
router.post("/create-event", async (req, res) => {
  try {
    const accessToken = await ensureValidOutlookToken();
    let { subject, startTime, endTime, location, leadEmail } = req.body;

    // 🕒 Ensure valid startTime
   if (!startTime) {
  console.error("⚠️ Missing startTime — event payload:", req.body);
  return res.status(400).json({ ok: false, error: "Missing startTime", payload: req.body });
}


    // ✅ Default to 30 minutes if endTime not provided or invalid
    const start = new Date(startTime);
    const end =
      endTime && !isNaN(new Date(endTime).getTime())
        ? new Date(endTime)
        : new Date(start.getTime() + 30 * 60 * 1000); // 30-minute slot

    const response = await fetch("https://graph.microsoft.com/v1.0/me/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subject,
        body: { contentType: "HTML", content: "Showing scheduled via Ava AI" },
        start: { dateTime: start.toISOString(), timeZone: "America/Edmonton" },
        end: { dateTime: end.toISOString(), timeZone: "America/Edmonton" },
        location: { displayName: location || "TBD" },
        attendees: leadEmail
          ? [{ emailAddress: { address: leadEmail }, type: "required" }]
          : [],
      }),
    });

    const json = await response.json();
if (!response.ok) throw new Error(json.error?.message || "Outlook API error");

// 💾 Save the Outlook event ID into the matching Booking record (if found)
if (json.id) {
  try {
    const booking = await prisma.booking.findFirst({
      where: {
        datetime: new Date(startTime),
        leadId: req.body.leadId,
      },
    });

    if (booking) {
      await prisma.booking.update({
        where: { id: booking.id },
        data: { outlookEventId: json.id, status: "confirmed" },
      });
      console.log(`📎 Linked booking ${booking.id} to Outlook event ${json.id}`);
    } else {
      console.warn("⚠️ No matching booking found to link Outlook event");
    }
  } catch (err) {
    console.error("❌ Failed to link booking to Outlook event:", err);
  }
}

res.json({ success: true, event: json });

  } catch (err) {
    console.error("❌ /create-event failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});



export default router;

// 🔄 Auto-refresh Outlook → Availability every 5 minutes (compact logs)
if (process.env.NODE_ENV === "production") {
  setInterval(async () => {
    const backendUrl =
      process.env.NEXT_PUBLIC_AI_BACKEND_URL || "https://aivoice-rental.onrender.com";
    try {
      const res = await fetch(`${backendUrl}/api/outlook-sync/poll`);
      const data = await res.json();

      const now = new Date().toLocaleTimeString("en-CA", {
        hour: "2-digit",
        minute: "2-digit",
      });
      console.log(
        `🕔 [OutlookSync ${now}] ${data.synced || 0} slots updated${data.error ? " ⚠️ " + data.error : ""}`
      );
    } catch (err) {
      console.warn("⚠️ [OutlookSync] Poll failed:", err.message);
    }
  }, 5 * 60 * 1000); // every 5 minutes
}

export { ensureValidOutlookToken };
