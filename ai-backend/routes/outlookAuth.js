// routes/outlookAuth.js
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const router = express.Router();

const CLIENT_ID = process.env.MS_GRAPH_CLIENT_ID;
const CLIENT_SECRET = process.env.MS_GRAPH_CLIENT_SECRET;
const TENANT_ID = process.env.MS_GRAPH_TENANT_ID || "common";
const REDIRECT_URI = `${process.env.NEXT_PUBLIC_AI_BACKEND_URL || "https://aivoice-rental.onrender.com"}/api/outlook/callback`;

// Step 1: Microsoft login redirect
router.get("/auth", (req, res) => {
  const authUrl =
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize` +
    `?client_id=${CLIENT_ID}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_mode=query` +
    `&scope=offline_access%20User.Read%20Calendars.ReadWrite`;
  res.redirect(authUrl);
});

// Step 2: OAuth callback
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
    console.log("🔑 Outlook tokens received:", tokens);

    if (tokens.error) throw new Error(tokens.error_description);
    res.json({ ok: true, message: "Outlook connected successfully", tokens });
  } catch (err) {
    console.error("❌ Outlook OAuth callback failed:", err);
    res.status(500).json({ ok: false, error: "OAUTH_ERROR", details: err.message });
  }
});

export default router;
