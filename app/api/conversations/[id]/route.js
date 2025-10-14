import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

export async function GET(_req, { params }) {
  const phone = decodeURIComponent(params.id);
  try {
    const [raw, properties, intent, summary, lastRead] = await Promise.all([
      redis.lrange(`lead:${phone}:history`, 0, -1),
      redis.smembers(`lead:${phone}:properties`),
      redis.get(`lead:${phone}:intent`).catch(() => null),
      redis.get(`lead:${phone}:summary`).catch(() => null),
      redis.get(`conv:${phone}:last_read`).catch(() => null),
    ]);

    const messages = raw.map((s) => {
      try {
        const j = JSON.parse(s);
        return { t: j.t || null, role: j.role || "assistant", content: j.content || String(s) };
      } catch {
        return { t: null, role: "assistant", content: String(s) };
      }
    });

    return NextResponse.json({
      ok: true,
      phone,
      properties,
      intent,
      summary,
      lastRead,
      messages,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
