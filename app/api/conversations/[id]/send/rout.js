import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

export async function POST(req, { params }) {
  const phone = decodeURIComponent(params.id);
  try {
    const { message } = await req.json();
    if (!message || typeof message !== 'string' || message.length > 2000) {
      return NextResponse.json({ ok: false, error: "Invalid message" }, { status: 400 });
    }

    const now = new Date().toISOString();

    // TODO: forward to AI/SMS backend here:
    // await fetch(process.env.AI_BACKEND_URL + '/send', { method: 'POST', body: JSON.stringify({ to: phone, text: message }) })

    // Store in history (assistant reply)
    const payload = JSON.stringify({ t: now, role: "assistant", content: message });
    await redis.rpush(`lead:${phone}:history`, payload);

    return NextResponse.json({ ok: true, phone, t: now });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
