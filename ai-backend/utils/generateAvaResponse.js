// ai-backend/utils/generateAvaResponse.js
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
