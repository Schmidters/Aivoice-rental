// app/api/conversations/[id]/send/route.js
import { NextResponse } from "next/server";

export async function POST(req, { params }) {
  try {
    const id = decodeURIComponent(params.id); // phone number
    const { text } = await req.json();
    const backend = process.env.NEXT_PUBLIC_AI_BACKEND_URL?.replace(/\/$/, "");

    if (!backend) {
      return NextResponse.json(
        { ok: false, error: "NEXT_PUBLIC_AI_BACKEND_URL not set" },
        { status: 500 }
      );
    }

    // Forward to backend /send/sms
    const r = await fetch(`${backend}/send/sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: id, text, agentId: "fraser" }),
    });

    const j = await r.json().catch(() => ({}));

    if (!r.ok) {
      console.error("Backend /send/sms error:", j);
      return NextResponse.json(
        { ok: false, error: j.error || "Failed to send" },
        { status: r.status }
      );
    }

    // Return immediately so dashboard shows it optimistically
    return NextResponse.json({ ok: true, proxied: true });
  } catch (err) {
    console.error("Send proxy error:", err);
    return NextResponse.json(
      { ok: false, error: err.message },
      { status: 500 }
    );
  }
}
