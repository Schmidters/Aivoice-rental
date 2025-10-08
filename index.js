require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { urlencoded } = require('express');
const http = require('http');

// --- Config ---
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const OPENAI_REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || 'verse';

// 🟢 Use your Render public URL (no localhost)
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://aivoice-rental.onrender.com';

// --- μ-law decode ---
function mulawDecodeSample(mu) {
  const MULAW_BIAS = 33;
  mu = ~mu & 0xFF;
  const sign = mu & 0x80;
  let exponent = (mu >> 4) & 0x07;
  let mantissa = mu & 0x0F;
  let sample = ((mantissa << 3) + MULAW_BIAS) << (exponent + 3);
  sample = sign ? (0x84 - sample) : (sample - 0x84);
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;
  return sample;
}

function mulawToPCM16(bufMuLawB64) {
  const raw = Buffer.from(bufMuLawB64, 'base64');
  const out = Buffer.alloc(raw.length * 2);
  for (let i = 0; i < raw.length; i++) {
    const pcm = mulawDecodeSample(raw[i]);
    out.writeInt16LE(pcm, i * 2);
  }
  return out;
}

function toBase64(buf) {
  return buf.toString('base64');
}

// --- Express app ---
const app = express();
app.use(urlencoded({ extended: false }));

// ✅ Browser test route
app.get('/', (req, res) => {
  res.send('✅ AI Voice Rental Assistant is live on Render!');
});

// ✅ Basic Twilio test route
app.get('/twiml/voice', (req, res) => {
  res.type('text/xml');
  res.send(`<Response><Say>Hello! This is a test. Your Twilio connection works.</Say></Response>`);
});

// 🧠 Real Twilio Voice route (POST)
app.post('/twiml/voice', (req, res) => {
  // 🟢 Always use your Render public WebSocket URL
  const wsUrl = `${PUBLIC_BASE_URL.replace(/^http/, 'ws')}/twilio-media`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Star
