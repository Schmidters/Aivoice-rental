import { NextResponse } from "next/server";
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL);

export async function GET() {
  try {
    // Get up to 100 recent bookings from the shared list
    const items = await redis.lrange("bookings", 0, 99);
    const bookings = items.map((raw) => {
      try {
        return JSON.parse(raw);
      } catch {
        return { raw };
      }
    });

    return NextResponse.json({ ok: true, count: bookings.length, bookings });
  } catch (err) {
    console.error("❌ /api/bookings error:", err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
