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
  maxSize: 100 * 1024 * 1024, // 100MB
  debug: process.env.NODE_ENV === "development",
});
```

```javascript
// next.config.js
export default {
  cacheComponents: true,
  cacheHandler: "./cache-handler.mjs", // Optional: ISR handler
  cacheHandlers: {
    default: "./data-cache-handler.mjs",
    remote: "./data-cache-handler.mjs",
  },
  cacheMaxMemorySize: 0,
};
```

That's it! This handles all `"use cache"` directives in your app.

## Redis / Valkey Cache Setup

For production or multi-instance deployments:

```bash
npm install ioredis
```

```javascript
// data-cache-handler.mjs
import { createCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

export default createCacheHandler({
  type: process.env.CACHE_BACKEND ?? "redis", // "redis" | "valkey"
  url: process.env.REDIS_URL ?? process.env.VALKEY_URL ?? "redis://localhost:6379",
  password: process.env.REDIS_PASSWORD,
  keyPrefix: "myapp:cache:",
  tagPrefix: "myapp:tags:",
  debug: process.env.NODE_ENV === "development",
});
```

### AWS ElastiCache (Redis-mode)

```javascript
// data-cache-handler.mjs
import { createCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

export default createCacheHandler({
  type: "elasticache",
  endpoint: process.env.ELASTICACHE_ENDPOINT,
  port: Number(process.env.ELASTICACHE_PORT ?? 6379),
  tls: process.env.ELASTICACHE_TLS !== "false",
  password: process.env.ELASTICACHE_AUTH_TOKEN ?? process.env.REDIS_PASSWORD,
  keyPrefix: "prod:cache:",
  tagPrefix: "prod:tags:",
});
```

> Tip: leave `url` unset for ElastiCache – the factory automatically switches to the `endpoint`/`port` signature when `type: "elasticache"` is used.

See [Redis Configuration](./redis.md) for advanced setup, Sentinel/Cluster instructions, and Valkey notes.

## Verification

Start your Next.js app:

```bash
npm run dev
```

You should see cache operations in the console if `debug: true`.
