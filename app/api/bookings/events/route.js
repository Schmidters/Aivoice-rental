// import Redis from "ioredis";
// (Redis disabled – DB-only mode)

// Disable static optimization
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
// const redis = new Redis(process.env.REDIS_URL);
console.log("🧠 Redis disabled in events route (DB-only mode)");

  const stream = new ReadableStream({
    start(controller) {
      const sub = new Redis(process.env.REDIS_URL);
      sub.subscribe("bookings:new");
      sub.on("message", (_ch, msg) => {
        controller.enqueue(`data: ${msg}\n\n`);
      });
    },
    cancel() {
      redis.disconnect();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
