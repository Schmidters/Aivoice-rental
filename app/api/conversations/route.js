import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

export async function GET() {
  try {
    const keys = await redis.keys("lead:*:history");
    const rows = [];

    for (const key of keys) {
      const phone = key.match(/lead:(\+?\d+)/)?.[1] || "unknown";

      const [prop, intent, lastArr, lastRead] = await Promise.all([
        redis.smembers(`lead:${phone}:properties`),
        redis.get(`lead:${phone}:intent`).catch(() => null),
        redis.lrange(key, -1, -1),
        redis.get(`conv:${phone}:last_read`).catch(() => null),
      ]);

      let lastMessage = null, lastTime = null, lastRole = null;
      if (lastArr?.[0]) {
        try {
          const parsed = JSON.parse(lastArr[0]);
          lastMessage = parsed.content || String(lastArr[0]);
          lastTime = parsed.t || null;
          lastRole = parsed.role || null;
        } catch {
          lastMessage = String(lastArr[0]);
        }
      }

      const unread =
        lastTime && lastRead ? new Date(lastTime) > new Date(lastRead) : !!lastTime && !lastRead;

      rows.push({
        id: phone,
        property: prop?.[0] || null,
        intent: intent || null,
        lastMessage,
        lastTime,
        lastRole,
        unread,
      });
    }

    rows.sort((a, b) => (b.lastTime || "").localeCompare(a.lastTime || ""));

    return NextResponse.json({ ok: true, count: rows.length, conversations: rows });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
