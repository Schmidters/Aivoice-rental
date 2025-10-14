import Redis from "ioredis";

let redis;

if (!redis) {
  redis = new Redis(process.env.REDIS_URL, {
    tls: process.env.REDIS_URL?.startsWith("rediss://") ? {} : undefined,
  });
}

export { redis };
