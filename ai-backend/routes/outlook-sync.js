// ai-backend/routes/outlook-sync.js
import express from "express";
import fetch from "node-fetch";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = express.Router();

// --- Create Microsoft Graph webhook subscriptions ---
router.post("/subscribe", async (req, res) => {
  try {
    const { accessToken } = req.body; // you’ll later use your saved token

    // List all calendars for the connected Outlook account
    const calRes = await fetch("https://graph.microsoft.com/v1.0/me/calendars", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const calData = await calRes.json();
    const calendars = calData.value || [];

    const subs = [];
    for (const cal of calendars) {
      const payload = {
        changeType: "created,updated,deleted",
        notificationUrl: `${process.env.DASHBOARD_ORIGIN}/api/outlook-sync/webhook`,
        resource: `/me/calendars/${cal.id}/events`,
        expirationDateTime: new Date(Date.now() + 1000 * 60 * 60 * 24 * 3).toISOString(), // 3 days
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
    res.status(500).json({ error: err.message });
  }
});

// --- Handle webhook events from Microsoft Graph ---
router.post("/webhook", async (req, res) => {
  // Validation handshake (Microsoft sends this once on subscription)
  if (req.query.validationToken) {
    return res.status(200).send(req.query.validationToken);
  }

  const notifications = req.body.value || [];
  for (const note of notifications) {
    console.log("📬 Received Outlook webhook:", note);
    // TODO: fetch event details (GET https://graph.microsoft.com/v1.0{note.resource})
    // then update your Prisma database if needed
  }

  res.sendStatus(202);
});

// --- Poll fallback (manual or cron) ---
router.get("/poll", async (req, res) => {
  try {
    const { accessToken } = req.query;
    const start = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString();
    const end = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString();
    const url = `https://graph.microsoft.com/v1.0/me/calendarview?startDateTime=${start}&endDateTime=${end}`;

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const json = await resp.json();
    res.json({ ok: true, data: json.value || [] });
  } catch (err) {
    console.error("❌ Outlook Poll Error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
