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

  if (expiresAt > now + 60 * 1000) {
    // Token still valid
    return account.accessToken;
  }

  console.log("🔄 Refreshing Outlook access token...");

  const params = new URLSearchParams({
    client_id: process.env.OUTLOOK_CLIENT_ID,
    client_secret: process.env.OUTLOOK_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
    redirect_uri: process.env.OUTLOOK_REDIRECT_URI,
  });

  const res = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  const json = await res.json();
  if (!json.access_token) {
  console.error("❌ Outlook token refresh failed:", JSON.stringify(json, null, 2));
  throw new Error(json.error_description || "Outlook token refresh failed");
}


  await prisma.calendarAccount.update({
    where: { id: account.id },
    data: {
      accessToken: json.access_token,
      refreshToken: json.refresh_token || account.refreshToken,
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
    },
  });

  console.log("✅ Outlook token refreshed");
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

      // Skip malformed events
      if (!e.start?.dateTime || !e.end?.dateTime) continue;

      const startTime = new Date(e.start.dateTime);
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

      await prisma.availability.create({
        data: {
          propertyId,
          startTime,
          endTime,
          isBlocked: true,
          notes: e.subject || "Busy",
        },
      });

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
    const { subject, startTime, endTime, location, leadEmail } = req.body;

    const response = await fetch("https://graph.microsoft.com/v1.0/me/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subject,
        body: { contentType: "HTML", content: "Showing scheduled via Ava AI" },
        start: { dateTime: startTime, timeZone: "America/Edmonton" },
        end: { dateTime: endTime, timeZone: "America/Edmonton" },
        location: { displayName: location || "TBD" },
        attendees: leadEmail
          ? [{ emailAddress: { address: leadEmail }, type: "required" }]
          : [],
      }),
    });

    const json = await response.json();
    if (!response.ok) throw new Error(json.error?.message || "Outlook API error");

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
