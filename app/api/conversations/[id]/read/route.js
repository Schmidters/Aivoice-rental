import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

export async function POST(_req, { params }) {
  const phone = decodeURIComponent(params.id);
  try {
    const now = new Date().toISOString();
    await redis.set(`conv:${phone}:last_read`, now);
    return NextResponse.json({ ok: true, phone, lastRead: now });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
