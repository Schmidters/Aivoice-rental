import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

export async function GET() {
  try {
    const keys = await redis.keys("lead:*");
    const leads = [];

    for (const key of keys) {
      const type = await redis.type(key);
      let data;

      // Handle each Redis type safely
      if (type === "string") {
        const val = await redis.get(key);
        try {
          data = JSON.parse(val);
        } catch {
          data = val;
        }
      } else if (type === "hash") {
        data = await redis.hgetall(key);
      } else if (type === "list") {
        data = await redis.lrange(key, 0, -1);
      } else if (type === "set") {
        data = await redis.smembers(key);
      } else {
        // Unsupported types or empty values
        data = null;
      }

      leads.push({ key, type, data });
    }

    return NextResponse.json({
      ok: true,
      count: leads.length,
      leads,
    });
  } catch (err) {
    console.error("Error fetching leads:", err);
    return NextResponse.json({ ok: false, error: err.message });
  }
}
