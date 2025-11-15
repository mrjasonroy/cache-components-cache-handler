import Redis from "ioredis";
import { createRedisDataCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

redis.on("error", (err) => {
  console.error("[Redis] Error:", err.message);
});

redis.on("connect", () => {
  console.log("[Redis] Connected successfully");
});

export default createRedisDataCacheHandler({
  redis,
  keyPrefix: "example:cache:",
  tagPrefix: "example:tags:",
  defaultTTL: 3600, // 1 hour
  debug: true,
});
