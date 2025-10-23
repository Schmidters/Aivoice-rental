import express from "express";
import fetch from "node-fetch";
import { PrismaClient } from "@prisma/client";

const router = express.Router();
const prisma = new PrismaClient();

// Utility: ensure token valid or refresh
async function getValidAccessToken(account) {
  if (new Date() < account.expiresAt) return account.accessToken;

  // Token expired → refresh it
  const params = new URLSearchParams({
    client_id: process.env.MS_GRAPH_CLIENT_ID,
    client_secret: process.env.MS_GRAPH_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
  });

  const res = await fetch(
    `https://login.microsoftonline.com/${process.env.MS_GRAPH_TENANT_ID}/oauth2/v2.0/token`,
    { method: "POST", body: params }
  );

  const tokens = await res.json();
  if (!tokens.access_token) throw new Error("Failed to refresh access token");

  await prisma.calendarAccount.update({
    where: { id: account.id },
    data: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || account.refreshToken,
      expiresAt: new Date(Date.now() + (tokens.expires_in - 60) * 1000),
    },
  });

  return tokens.access_token;
}

//
// 🕒 GET /api/outlook/availability
//   → Check the agent’s free/busy schedule
//
router.get("/api/outlook/availability", async (req, res) => {
  try {
    const agentId = 1; // Replace later with real authenticated user
    const account = await prisma.calendarAccount.findFirst({
      where: { userId: agentId, provider: "outlook" },
    });

    if (!account) return res.status(404).json({ error: "Outlook not connected" });

    const accessToken = await getValidAccessToken(account);

    // Define time range (next 7 days)
    const start = new Date();
    const end = new Date();
    end.setDate(start.getDate() + 7);

    const response = await fetch(
      "https://graph.microsoft.com/v1.0/me/calendar/getSchedule",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          schedules: [account.email],
          startTime: {
            dateTime: start.toISOString(),
            timeZone: "UTC",
          },
          endTime: {
            dateTime: end.toISOString(),
            timeZone: "UTC",
          },
          availabilityViewInterval: 30,
        }),
      }
    );

    const data = await response.json();
    res.json(data.value?.[0] || { message: "No availability data" });
  } catch (err) {
    console.error("Outlook availability error:", err);
    res.status(500).json({ error: "Failed to fetch Outlook availability" });
  }
});

//
// 📅 POST /api/outlook/create-event
//   → Create a tentative showing in the agent’s calendar
//
router.post("/api/outlook/create-event", async (req, res) => {
  try {
    const agentId = 1; // Replace later
    const account = await prisma.calendarAccount.findFirst({
      where: { userId: agentId, provider: "outlook" },
    });
    if (!account) return res.status(404).json({ error: "Outlook not connected" });

    const accessToken = await getValidAccessToken(account);
    const { startTime, endTime, subject, location, leadEmail } = req.body;

    const eventPayload = {
      subject: subject || "Tentative showing",
      body: { contentType: "HTML", content: "Tentative showing scheduled by Ava." },
      start: { dateTime: startTime, timeZone: "UTC" },
      end: { dateTime: endTime, timeZone: "UTC" },
      location: { displayName: location || "TBD" },
      attendees: leadEmail
        ? [{ emailAddress: { address: leadEmail }, type: "required" }]
        : [],
      isOnlineMeeting: true,
      showAs: "tentative",
    };

    const response = await fetch("https://graph.microsoft.com/v1.0/me/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(eventPayload),
    });

    const data = await response.json();
    res.json({ success: true, event: data });
  } catch (err) {
    console.error("Outlook event creation error:", err);
    res.status(500).json({ error: "Failed to create Outlook event" });
  }
});

export default router;
