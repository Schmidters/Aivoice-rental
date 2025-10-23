// ai-backend/routes/outlook-sync.js
import express from "express";
import fetch from "node-fetch";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = express.Router();

/**
 * 🔹 1. GET /api/outlook-sync/events
 * Returns all events (Busy, Tentative, etc.) from Outlook calendar
 * for the next 7 days, used by your dashboard unified calendar.
 */
router.get("/events", async (req, res) => {
  try {
    const account = await prisma.calendarAccount.findFirst({
      where: { provider: "outlook" },
    });

    if (!account || !account.accessToken) {
      return res.status(401).json({
        ok: false,
        error: "No Outlook account connected or token missing.",
      });
    }

    const now = new Date().toISOString();
    const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const graphUrl = `https://graph.microsoft.com/v1.0/me/calendarview?startdatetime=${now}&enddatetime=${nextWeek}&$select=subject,start,end,location,showAs`;
    const graphRes = await fetch(graphUrl, {
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
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
 * Creates webhook subscriptions (future automation).
 */
router.post("/subscribe", async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) return res.status(400).json({ ok: false, error: "Missing token" });

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

      const subData = await subRes.json();
      subs.push(subData);
    }

    res.json({ ok: true, subs });
  } catch (err) {
    console.error("❌ Outlook Subscribe Error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * 🔹 3. POST /api/outlook-sync/webhook
 * Handles Microsoft Graph notifications (future use).
 */
router.post("/webhook", async (req, res) => {
  // Validation handshake (Microsoft sends this once on subscription)
  if (req.query.validationToken) {
    return res.status(200).send(req.query.validationToken);
  }

  const notifications = req.body.value || [];
  for (const note of notifications) {
    console.log("📬 Received Outlook webhook:", note);
    // You could later fetch event details here if desired
  }

  res.sendStatus(202);
});

/**
 * 🔹 4. GET /api/outlook-sync/poll
 * Manual fallback endpoint — useful for testing token validity.
 */
router.get("/poll", async (req, res) => {
  try {
    const account = await prisma.calendarAccount.findFirst({
      where: { provider: "outlook" },
    });
    if (!account || !account.accessToken) {
      return res.status(401).json({ ok: false, error: "No Outlook account" });
    }

    const start = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const url = `https://graph.microsoft.com/v1.0/me/calendarview?startdatetime=${start}&enddatetime=${end}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${account.accessToken}` },
    });

    const json = await resp.json();
    res.json({ ok: true, data: json.value || [] });
  } catch (err) {
    console.error("❌ Outlook Poll Error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
