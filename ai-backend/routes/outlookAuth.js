// routes/outlookAuth.js
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const router = express.Router();

// 🧠 Match your actual env variable names on DigitalOcean
const CLIENT_ID = process.env.AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const TENANT_ID = process.env.AZURE_TENANT_ID || "common";
const REDIRECT_URI = process.env.AZURE_REDIRECT_URI;

// Step 1: Microsoft login redirect
router.get("/connect", (req, res) => {
  const authUrl =
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize` +
    `?client_id=${CLIENT_ID}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_mode=query` +
    `&scope=offline_access%20User.Read%20Calendars.ReadWrite`;
  res.redirect(authUrl);
});

// ✅ Step 2: OAuth callback (single version, saves to DB)
router.get("/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).json({ ok: false, error: "Missing auth code" });

  try {
    const tokenRes = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });

    const tokens = await tokenRes.json();
    if (tokens.error) throw new Error(tokens.error_description);

    // 🔍 Try to decode email from id_token or fetch from Graph if missing
let email = "unknown@domain.com";

if (tokens.id_token) {
  const payload = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64").toString());
  email = payload.preferred_username || payload.email || email;
}

// If still unknown, fetch from Microsoft Graph /me
if (email === "unknown@domain.com") {
  try {
    const profileRes = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await profileRes.json();
    email = profile.userPrincipalName || profile.mail || email;
  } catch (err) {
    console.warn("⚠️ Could not fetch email from Graph:", err.message);
  }
}


    // 🕒 Calculate expiration
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // 💾 Save tokens to DB
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();

    await prisma.calendarAccount.upsert({
      where: {
        userId_provider: {
          userId: 1, // replace later when multi-agent
          provider: "outlook",
        },
      },
      update: {
        email,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt,
      },
      create: {
        userId: 1,
        provider: "outlook",
        email,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt,
      },
    });

    res.json({
      ok: true,
      message: "Outlook connected and tokens saved successfully",
      email,
      expiresAt,
    });
  } catch (err) {
    console.error("❌ Outlook OAuth callback failed:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
