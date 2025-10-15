// dashboard/app/api/bookings/route.js
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const base = process.env.NEXT_PUBLIC_AI_BACKEND_URL?.replace(/\/$/, "");
  if (!base) {
    return NextResponse.json({ ok: false, error: "Missing NEXT_PUBLIC_AI_BACKEND_URL" }, { status: 500 });
  }
  try {
    const r = await fetch(`${base}/api/bookings`, { cache: "no-store" });
    const j = await r.json();
    return NextResponse.json(j);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
