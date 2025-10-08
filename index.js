require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { urlencoded } = require('express');
const http = require('http');
const fs = require('fs');
const twilio = require('twilio');

// --- Config ---
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const OPENAI_REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || 'verse';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://aivoice-rental.onrender.com';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- Helpers for μ-law audio ---
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

// ✅ Health check
app.get('/', (req, res) => {
  res.send('✅ AI Voice Rental Assistant is live on Render!');
});

// ✅ Voice test route
app.get('/twiml/voice', (req, res) => {
  res.type('text/xml');
  res.send(`<Response><Say>Hello! This is a test. Your Twilio connection works.</Say></Response>`);
});

// 🧠 Twilio Voice route
app.post('/twiml/voice', (req, res) => {
  const wsUrl = `${PUBLIC_BASE_URL.replace(/^http/, 'ws')}/twilio-media`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="${wsUrl}" track="inbound_audio outbound_audio"/>
  </Start>
  <Say voice="Polly.Joanna">Hi, connecting you to the rental assistant now.</Say>
</Response>`;
  res.type('text/xml');
  res.send(twiml);
});

// --- Chat memory (persistent) ---
const conversationsFile = './conversations.json';

function loadConversations() {
  try {
    return JSON.parse(fs.readFileSync(conversationsFile, 'utf-8'));
  } catch {
    return {};
  }
}

function saveConversations(data) {
  fs.writeFileSync(conversationsFile, JSON.stringify(data, null, 2));
}

// 💬 Twilio SMS route with AI + persistent memory + human delay
// 💬 Global in-memory conversation storage
const conversations = {};

app.post('/twiml/sms', express.urlencoded({ extended: false }), async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim() || '';
  console.log(`📩 SMS from ${from}: ${body}`);

  // Respond immediately to Twilio (so it doesn’t retry)
  res.type('text/xml');
  res.send('<Response></Response>');

  // Random human-like delay (10–20 seconds)
  const delayMs = 10000 + Math.random() * 10000;

  setTimeout(async () => {
    try {
      // Create a conversation if this is a new sender
      if (!conversations[from]) {
        conversations[from] = [
          {
            role: 'system',
            content:
              'You are a friendly, natural-sounding rental assistant. Reply casually and warmly. Ask short follow-up questions to help schedule showings or collect move-in details.'
          }
        ];
      }

      // Add user message
      conversations[from].push({ role: 'user', content: body });

      // Generate AI response
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: conversations[from],
          max_tokens: 120
        })
      });

      const data = await response.json();
      const replyText =
        data.choices?.[0]?.message?.content?.trim() ||
        "Thanks for reaching out! When would you like to come for a showing?";

      // Add assistant reply to memory
      conversations[from].push({ role: 'assistant', content: replyText });

      // Send reply via Twilio
      await twilioClient.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to: from,
        body: replyText
      });

      console.log(`💬 Replied to ${from} after ${Math.round(delayMs / 1000)}s: ${replyText}`);
    } catch (err) {
      console.error('❌ Error sending AI SMS:', err);
    }
  }, delayMs);
});


// --- WebSocket server (for voice calls) ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/twilio-media' });

// Connect to OpenAI Realtime
function connectOpenAIRealtime(onAudioOut, onReady) {
  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    'OpenAI-Beta': 'realtime=v1'
  };
  const url = `wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_MODEL}&voice=${OPENAI_REALTIME_VOICE}`;
  const ws = new (require('ws'))(url, { headers });

  ws.on('open', () => {
    const system = {
      type: 'session.update',
      session: {
        instructions: [
          'You are a friendly AI leasing assistant for residential rentals.',
          'Greet politely, ask which property they’re calling about, collect their name and move-in timeframe.',
          'Speak in short, clear sentences (max two per reply).'
        ].join(' ')
      }
    };
    ws.send(JSON.stringify(system));
    if (onReady) onReady();
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'output_audio.delta' && msg.audio) {
        const pcm = Buffer.from(msg.audio, 'base64');
        onAudioOut && onAudioOut(pcm);
      }
    } catch {}
  });

  return {
    appendPCM16: (pcm16Buffer) => {
      ws.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: toBase64(pcm16Buffer)
        })
      );
    },
    commitInput: () => {
      ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      ws.send(JSON.stringify({ type: 'response.create' }));
    },
    close: () => {
      try {
        ws.close();
      } catch {}
    }
  };
}

// Twilio Media Stream handler
wss.on('connection', (twilioWS) => {
  console.log('🔊 Twilio media stream connected');
  let pcmBufferQueue = [];
  let lastMediaAt = Date.now();

  const ai = connectOpenAIRealtime((pcmOut) => {
    const muBuf = Buffer.alloc(pcmOut.length / 2);
    for (let i = 0, j = 0; i < pcmOut.length; i += 2, j++) {
      const sample = pcmOut.readInt16LE(i);
      const BIAS = 33;
      let sign = sample < 0 ? 0x80 : 0;
      let pcm = Math.abs(sample);
      if (pcm > 32635) pcm = 32635;
      pcm += BIAS;
      let exponent = 7;
      for (
        let expMask = 0x4000;
        (pcm & expMask) === 0 && exponent > 0;
        exponent--, expMask >>= 1
      ) {}
      let mantissa = (pcm >> ((exponent === 0 ? 4 : exponent + 3))) & 0x0f;
      let mu = ~(sign | (exponent << 4) | mantissa) & 0xff;
      muBuf[j] = mu;
    }
    twilioWS.send(
      JSON.stringify({ event: 'media', media: { payload: muBuf.toString('base64') } })
    );
  });

  const tick = setInterval(() => {
    const now = Date.now();
    if (pcmBufferQueue.length > 0 && now - lastMediaAt > 600) {
      const merged = Buffer.concat(pcmBufferQueue);
      pcmBufferQueue = [];
      ai.appendPCM16(merged);
      ai.commitInput();
    }
  }, 200);

  twilioWS.on('message', (msg) => {
    const data = JSON.parse(msg.toString());
    switch (data.event) {
      case 'media':
        const pcm16 = mulawToPCM16(data.media.payload);
        pcmBufferQueue.push(pcm16);
        lastMediaAt = Date.now();
        break;
      case 'stop':
        if (pcmBufferQueue.length > 0) {
          const merged = Buffer.concat(pcmBufferQueue);
          pcmBufferQueue = [];
          ai.appendPCM16(merged);
          ai.commitInput();
        }
        break;
    }
  });

  twilioWS.on('close', () => {
    clearInterval(tick);
    ai.close();
    console.log('🔚 Twilio media stream closed');
  });

  twilioWS.on('error', (e) => console.error('Twilio WS error:', e.message));
});

// --- Start server ---
server.listen(PORT, () => {
  console.log(`✅ Server listening on :${PORT}`);
  console.log(`🌐 TwiML endpoint: POST ${PUBLIC_BASE_URL}/twiml/voice`);
  console.log(`💬 SMS endpoint: POST ${PUBLIC_BASE_URL}/twiml/sms`);
  console.log(`🔗 WebSocket endpoint: ${PUBLIC_BASE_URL.replace(/^http/, 'ws')}/twilio-media`);
});
