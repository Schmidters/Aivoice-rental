import { NextResponse } from "next/server";
import { redis } from "../../../lib/redis";


export async function GET() {
  try {
    const keys = await redis.keys("*");
    return NextResponse.json({ ok: true, keys });
  } catch (err) {
    console.error("Redis test failed:", err);
    return NextResponse.json({ ok: false, error: err.message });
  }
}
