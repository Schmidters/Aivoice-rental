import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

export async function GET() {
  try {
    // find all leads that have history
    const keys = await redis.keys("lead:*:history");
    const rows = [];

    for (const key of keys) {
      const phone = key.match(/lead:(\+?\d+)/)?.[1] || "unknown";
      // get property + intent
      const prop = await redis.smembers(`lead:${phone}:properties`);
      const intent = await redis.get(`lead:${phone}:intent`).catch(() => null);

      // last message (parse JSON string if needed)
      const last = await redis.lrange(key, -1, -1);
      let lastMsg = null, lastTime = null, lastRole = null;
      if (last?.[0]) {
        try {
          const parsed = JSON.parse(last[0]);
          lastMsg = parsed.content || String(last[0]);
          lastTime = parsed.t || null;
          lastRole = parsed.role || null;
        } catch {
          lastMsg = String(last[0]);
        }
      }

      rows.push({
        id: phone,
        property: prop?.[0] || null,
        intent: intent || null,
        lastMessage: lastMsg,
        lastTime,
        lastRole,
      });
    }

    // newest first
    rows.sort((a, b) => (b.lastTime || 0).localeCompare(a.lastTime || 0));

    return NextResponse.json({ ok: true, count: rows.length, conversations: rows });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
