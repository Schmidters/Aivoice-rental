// /lib/redis.js
import Redis from "ioredis";

// Single connection instance for the whole app
let redis;

if (!redis) {
  redis = new Redis(process.env.REDIS_URL, {
    tls: process.env.REDIS_URL?.startsWith("rediss://") ? {} : undefined,
  });
}

export { redis };
