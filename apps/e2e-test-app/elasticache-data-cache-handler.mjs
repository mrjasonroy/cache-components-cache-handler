import { createRedisDataCacheHandler } from "@mrjasonroy/cache-components-cache-handler";
import Redis from "ioredis";

/**
 * ElastiCache data cache handler with IAM authentication support
 *
 * This handler supports both password-based and IAM authentication for AWS ElastiCache.
 *
 * Environment variables:
 * - ELASTICACHE_ENDPOINT: ElastiCache cluster endpoint (required)
 * - ELASTICACHE_PORT: Port number (default: 6379)
 * - ELASTICACHE_USE_IAM: Set to "true" to use IAM auth (default: false)
 * - ELASTICACHE_USER: Username for IAM auth (default: "default")
 * - AWS_REGION: AWS region for IAM auth (required if using IAM)
 * - AWS_ACCESS_KEY_ID: AWS access key for IAM auth
 * - AWS_SECRET_ACCESS_KEY: AWS secret key for IAM auth
 * - ELASTICACHE_AUTH_TOKEN: Password for auth token mode
 */

const useIAM = process.env.ELASTICACHE_USE_IAM === "true";
const endpoint = process.env.ELASTICACHE_ENDPOINT;
const port = Number.parseInt(process.env.ELASTICACHE_PORT || "6379", 10);

if (!endpoint) {
  throw new Error("ELASTICACHE_ENDPOINT environment variable is required");
}

/**
 * Create Redis client with ElastiCache configuration
 */
function createElastiCacheClient() {
  const config = {
    host: endpoint,
    port,
    // Enable TLS for ElastiCache in-transit encryption
    tls: process.env.ELASTICACHE_TLS === "true" ? {} : undefined,
    // Connection settings
    connectTimeout: 10000,
    retryStrategy: (times) => {
      if (times > 3) {
        console.error("[ElastiCache] Max retry attempts reached");
        return null;
      }
      return Math.min(times * 200, 2000);
    },
  };

  // Add authentication based on mode
  if (useIAM) {
    // IAM authentication requires AWS SDK
    console.log("[ElastiCache] Using IAM authentication");

    if (!process.env.AWS_REGION) {
      throw new Error("AWS_REGION is required for IAM authentication");
    }

    // For IAM auth, we need to use AWS Signature Version 4
    // The ioredis library doesn't support this natively, so we use password auth
    // with AWS credentials. The username format is: {username}:{region}:{replication-group-id}
    const username = process.env.ELASTICACHE_USER || "default";
    const region = process.env.AWS_REGION;

    // Note: For true IAM auth, you would typically use a library like
    // @aws-sdk/credential-providers to generate tokens, but for simplicity
    // in testing, we'll use environment-provided credentials
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      // This is a simplified approach for testing
      // In production, use AWS SDK to generate proper IAM auth tokens
      config.username = username;
      config.password = process.env.AWS_SECRET_ACCESS_KEY;
    } else {
      console.warn("[ElastiCache] IAM auth enabled but AWS credentials not found");
    }
  } else if (process.env.ELASTICACHE_AUTH_TOKEN) {
    // Password-based authentication
    console.log("[ElastiCache] Using auth token authentication");
    config.password = process.env.ELASTICACHE_AUTH_TOKEN;
  } else {
    console.log("[ElastiCache] No authentication configured");
  }

  return new Redis(config);
}

// Create and connect Redis client
const redis = createElastiCacheClient();

// Handle connection events
redis.on("error", (err) => {
  console.error("[ElastiCache] Connection error:", err);
});

redis.on("connect", () => {
  console.log("[ElastiCache] Connected successfully to", endpoint);
});

redis.on("ready", () => {
  console.log("[ElastiCache] Ready to accept commands");
});

redis.on("close", () => {
  console.log("[ElastiCache] Connection closed");
});

// Export the data cache handler
export default createRedisDataCacheHandler({
  redis,
  keyPrefix: "e2e:cache:",
  tagPrefix: "e2e:tags:",
  defaultTTL: 86400, // 24 hours
  debug: process.env.CACHE_DEBUG === "true",
});
