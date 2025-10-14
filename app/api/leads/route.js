import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

export async function GET() {
  try {
    const keys = await redis.keys("lead:*");
    const leadsByPhone = {};

    for (const key of keys) {
      const type = await redis.type(key);
      const phoneMatch = key.match(/lead:\+?\d+/);
      if (!phoneMatch) continue;
      const phone = phoneMatch[0].replace("lead:", "");

      let data;
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
        data = await redis.lrange(key, -1, -1); // last message only
        if (data?.length && typeof data[0] === "string") {
          try {
            const msg = JSON.parse(data[0]);
            data = msg.content;
          } catch {
            data = data[0];
          }
        }
      } else if (type === "set") {
        data = await redis.smembers(key);
      }

      if (!leadsByPhone[phone]) leadsByPhone[phone] = { phone };
      if (key.includes(":intent")) leadsByPhone[phone].intent = data;
      if (key.includes(":properties")) leadsByPhone[phone].property = data?.[0];
      if (key.includes(":summary")) leadsByPhone[phone].summary = data;
      if (key.includes(":history")) leadsByPhone[phone].lastMessage = data;
    }

    const leads = Object.values(leadsByPhone);
    return NextResponse.json({ ok: true, count: leads.length, leads });
  } catch (err) {
    console.error("Error fetching leads:", err);
    return NextResponse.json({ ok: false, error: err.message });
  }
}
