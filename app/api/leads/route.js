import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

export async function GET() {
  try {
    const keys = await redis.keys("lead:*");

    const leads = await Promise.all(
      keys.map(async (key) => {
        const raw = await redis.get(key);
        let data = {};
        try {
          data = JSON.parse(raw || "{}");
        } catch {
          // fallback if not valid JSON
          data = { raw };
        }

        // extract phone number from key (e.g. lead:+18258631111:summary)
        const phone = key.split(":")[1]?.replace("+1", "") || "unknown";

        return {
          id: key,
          phone,
          message: data.message || data.summary || "",
          intent: data.intent || "",
          property: data.property || "",
          timestamp: data.timestamp || null,
        };
      })
    );

    return NextResponse.json({ leads });
  } catch (err) {
    console.error("Error fetching leads:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
