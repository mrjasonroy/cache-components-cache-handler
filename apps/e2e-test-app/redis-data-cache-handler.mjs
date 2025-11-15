import { createRedisDataCacheHandler } from "@mrjasonroy/cache-components-cache-handler";
import { createClient } from "redis";

// Create Redis client
const redis = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

// Connect with error handling
redis.on("error", (err) => {
  console.error("[Redis] Connection error:", err);
});

try {
  await redis.connect();
  console.log("[Redis] Connected successfully");
} catch (error) {
  console.error("[Redis] Failed to connect:", error);
  throw error;
}

// Export the data cache handler
export default createRedisDataCacheHandler({
  redis,
  keyPrefix: "e2e:cache:",
  tagPrefix: "e2e:tags:",
  defaultTTL: 86400, // 24 hours
  debug: process.env.CACHE_DEBUG === "true",
});
