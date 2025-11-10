# Installation & Setup

## Prerequisites

- Node.js 22+
- Next.js 16+
- pnpm, npm, or yarn

## Basic Installation

```bash
npm install @mrjasonroy/cache-components-cache-handler
```

## Memory Cache Setup

For development or single-instance deployments:

```javascript
// data-cache-handler.mjs
import { createMemoryDataCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

export default createMemoryDataCacheHandler({
  maxSize: 100 * 1024 * 1024, // 100MB (default: 50MB)
  debug: process.env.NODE_ENV === "development",
});
```

```javascript
// next.config.js
module.exports = {
  experimental: {
    cacheComponents: true,
    cacheHandlers: {
      default: require.resolve("./data-cache-handler.mjs"),
    },
  },
};
```

## Redis Cache Setup

For production or multi-instance deployments:

```bash
npm install redis
```

```javascript
// data-cache-handler.mjs
import { createClient } from "redis";
import { createRedisDataCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

const redis = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

redis.on("error", (err) => console.error("Redis error:", err));
await redis.connect();

export default createRedisDataCacheHandler({
  redis,
  keyPrefix: "myapp:cache:",
  tagPrefix: "myapp:tags:",
  defaultTTL: 86400, // 24 hours
  debug: process.env.NODE_ENV === "development",
});
```

See [Redis Configuration](./redis.md) for advanced setup.

## Verification

Start your Next.js app:

```bash
npm run dev
```

You should see cache operations in the console if `debug: true`.
