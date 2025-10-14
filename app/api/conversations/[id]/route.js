import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

export async function GET(_req, { params }) {
  const phone = decodeURIComponent(params.id);
  try {
    const historyKey = `lead:${phone}:history`;
    const raw = await redis.lrange(historyKey, 0, -1);

    const messages = raw.map((s) => {
      try {
        const j = JSON.parse(s);
        return {
          t: j.t || null,
          role: j.role || "assistant",
          content: j.content || String(s),
        };
      } catch {
        return { t: null, role: "assistant", content: String(s) };
      }
    });

    const properties = await redis.smembers(`lead:${phone}:properties`);
    const intent = await redis.get(`lead:${phone}:intent`).catch(() => null);
    const summary = await redis.get(`lead:${phone}:summary`).catch(() => null);

    return NextResponse.json({
      ok: true,
      phone,
      properties,
      intent,
      summary,
      messages,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
