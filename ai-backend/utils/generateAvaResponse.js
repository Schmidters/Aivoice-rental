// ai-backend/utils/generateAvaResponse.js
import OpenAI from "openai";
import fetch from "node-fetch";


const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });


// ============================================
// 🧠 Create an Outlook event through Ava's API
// ============================================
export async function createOutlookEvent(property, dateTime, leadEmail) {
  try {
    const start = new Date(dateTime);
    const end = new Date(start.getTime() + 30 * 60 * 1000); // 30-minute slot

    const payload = {
      subject: `Showing – ${property}`,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      location: property,
      leadEmail,
    };

    const res = await fetch(`${process.env.DASHBOARD_ORIGIN}/api/outlook-sync/create-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const json = await res.json();
    if (!json.success) {
      console.error("❌ Failed to create Outlook event:", json.error);
    } else {
      console.log("✅ Outlook event created:", json.event?.subject);
    }
  } catch (err) {
    console.error("❌ createOutlookEvent() error:", err);
  }
}

/**
 * Generate a natural, human-sounding text message for Ava.
 *
 * @param {string} type - The response scenario (e.g., "past_time", "slot_taken", "booking_confirmed")
 * @param {object} data - Optional data like nextSlots, time, propertyName, etc.
 * @returns {Promise<string>} AI-generated text
 */
export async function generateAvaResponse(type, data = {}) {
  const { nextSlots = [], startFmt, propertyName } = data;

  let situation = "";
  switch (type) {
    case "past_time":
      situation = `The renter asked for a showing time that already passed. Gently ask them to suggest another time.`;
      break;

    case "slot_taken":
      situation = `The renter requested a time that’s already booked. Offer them one or two alternate times: ${nextSlots.join(", ")}. Be warm and conversational.`;
      break;

    case "no_slots":
      situation = `There are no available showing times soon. Politely ask what other days might work.`;
      break;

    case "booking_confirmed":
      situation = `The renter’s showing was successfully booked for ${startFmt} at ${propertyName || "the property"}. Send a warm confirmation message.`;
      break;

    default:
      situation = `The renter sent a general message about scheduling. Respond naturally.`;
  }

  const systemPrompt = `
You are "Ava", a friendly, real leasing assistant for a property management company.
You text like a real person — warm, confident, concise, and natural.
Avoid robotic or repetitive phrasing.
Don't overuse emojis (use at most one friendly emoji like 😊 if it fits).
Keep replies under 2 short sentences.
Never use filler like "as an AI" or "I'm sorry".
`;

  try {
    const resp = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.8,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: situation },
      ],
    });

    const reply = resp.choices?.[0]?.message?.content?.trim();
    return reply || "Got it! Let’s find another time that works for you.";
  } catch (err) {
    console.error("❌ generateAvaResponse failed:", err);
    return "Got it! Let’s find another time that works for you.";
  }
}
