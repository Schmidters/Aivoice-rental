import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

export async function GET() {
  try {
    // Try multiple naming schemes:
    // - booking:*
    // - property:*:bookings
    // - lead:*:bookings (fallback)
    const patterns = ["booking:*", "property:*:bookings", "lead:*:bookings"];
    const seen = new Set();
    const items = [];

    for (const pat of patterns) {
      const keys = await redis.keys(pat);
      for (const key of keys) {
        if (seen.has(key)) continue;
        seen.add(key);

        const type = await redis.type(key);
        let data = null;

        if (type === "string") {
          const v = await redis.get(key);
          try { data = JSON.parse(v); } catch { data = v; }
        } else if (type === "hash") {
          data = await redis.hgetall(key);
        } else if (type === "list") {
          // Return last one as a primary preview; include all in _list if we want details
          const all = await redis.lrange(key, 0, -1);
          data = { _list: all };
        } else if (type === "set") {
          const all = await redis.smembers(key);
          data = { _set: all };
        } else {
          data = `Unsupported type: ${type}`;
        }

        // Try to derive a phone/property from key
        const phone = key.match(/\+?\d{7,}/)?.[0] || null;
        const property = key.includes("property:")
          ? key.split("property:")[1]?.split(":")[0]
          : null;

        items.push({ key, type, phone, property, data });
      }
    }

    // Best-effort normalize: a "booking" row should at least have phone or property.
    // Sort newest-ish by presence of _list/_set length desc, then by key name.
    items.sort((a, b) => {
      const aLen = (a.data?._list?.length || a.data?._set?.length || 0);
      const bLen = (b.data?._list?.length || b.data?._set?.length || 0);
      if (bLen !== aLen) return bLen - aLen;
      return a.key.localeCompare(b.key);
    });

    return NextResponse.json({ ok: true, count: items.length, items });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
