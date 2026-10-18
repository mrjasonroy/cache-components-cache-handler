# API Reference

Everything this package exports is for Next.js's `cacheHandlers` (plural) config, which backs
`"use cache"` and `"use cache: remote"`. There is no ISR `cacheHandler` (singular) export; it was
removed in 16.5.0 (see the README's "Migrating from the ISR handler").

## Zero-config factory

### `createCacheHandler(options)`

Returns a data cache handler for the chosen backend: `"memory"`, `"redis"`, `"valkey"` or
`"elasticache"`. Redis-family backends load `ioredis` lazily, so memory-only users do not need it
installed. See [redis.md](./redis.md) for options and environment variables.

For Redis-family backends in production it logs a one-time warning that ISR pages and route
handlers are not covered by this package (see the README's migration section). Pass
`suppressIsrWarning: true` to silence it once you have your own shared ISR `cacheHandler`.

```javascript
// data-cache-handler.mjs
import { createCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

export default createCacheHandler({ type: process.env.REDIS_URL ? "redis" : "memory" });
```

## Memory Cache Handler

### `createMemoryDataCacheHandler(options)`

Creates a memory-based cache handler.

**Options:**

```typescript
{
  maxSize?: number;  // Maximum cache size in bytes (default: 50MB)
  debug?: boolean;   // Enable debug logging (default: false)
}
```

**Example:**

```javascript
import { createMemoryDataCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

export default createMemoryDataCacheHandler({
  maxSize: 100 * 1024 * 1024, // 100MB
  debug: true,
});
```

## Redis Cache Handler

### `createRedisDataCacheHandler(options)`

Creates a Redis-based cache handler.

**Options:**

```typescript
{
  redis: RedisClientType;     // Connected Redis client (required)
  keyPrefix?: string;         // Prefix for cache keys (default: "nextjs:data-cache:")
  tagPrefix?: string;         // Prefix for tag keys (default: "nextjs:tags:")
  defaultTTL?: number;        // Default TTL in seconds (default: 86400)
  debug?: boolean;            // Enable debug logging (default: false)
}
```

**Example:**

```javascript
import { createClient } from "redis";
import { createRedisDataCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

export default createRedisDataCacheHandler({
  redis,
  keyPrefix: "myapp:cache:",
  tagPrefix: "myapp:tags:",
  defaultTTL: 3600, // 1 hour
  debug: process.env.NODE_ENV === "development",
});
```

> `redis` must be a **node-redis-style** client. node-redis (`createClient`)
> works directly; for **ioredis**, wrap it with `createIoredisAdapter` (below).

### `createIoredisAdapter(client)`

Wraps an [ioredis](https://github.com/redis/ioredis) client (or `Cluster`) so it
satisfies the node-redis-style `RedisClient` contract expected by
`createRedisDataCacheHandler`. It translates node-redis SET options
(`{ EX: seconds }`) to ioredis positional args (`"EX", seconds`); without it,
Redis rejects writes with `ERR syntax error` and TTLs silently fail.

```javascript
import Redis from "ioredis";
import {
  createRedisDataCacheHandler,
  createIoredisAdapter,
} from "@mrjasonroy/cache-components-cache-handler";

const redis = new Redis(process.env.REDIS_URL);

export default createRedisDataCacheHandler({
  redis: createIoredisAdapter(redis),
});
```

## next.config helpers

### `createCacheConfig({ dataCacheHandlerPath, disableDefaultMemoryCache? })`

Returns `{ cacheHandlers: { default, remote }, cacheMaxMemorySize }` with both profiles pointing at
the same handler file. `disableDefaultMemoryCache` defaults to `true` (sets `cacheMaxMemorySize: 0`).

### `createCacheConfigWithProfiles({ defaultDataCacheHandlerPath, remoteDataCacheHandlerPath, disableDefaultMemoryCache? })`

Same, with separate handler files for `"use cache"` and `"use cache: remote"`.

```javascript
// next.config.mjs
import { resolve } from "node:path";
import { createCacheConfig } from "@mrjasonroy/cache-components-cache-handler";

export default {
  cacheComponents: true,
  ...createCacheConfig({
    dataCacheHandlerPath: resolve(process.cwd(), "./data-cache-handler.mjs"),
  }),
};
```

Neither helper sets the ISR `cacheHandler` key; the `isrHandlerPath` option was removed in 16.5.0.

## Next.js Cache APIs

These are Next.js built-in APIs that work with this cache handler.

### `cacheLife(profile)`

Set cache lifetime using a profile.

**Built-in profiles:** `"seconds"`, `"minutes"`, `"hours"`, `"days"`, `"weeks"`

**Example:**

```typescript
import { cacheLife } from "next/cache";

async function MyComponent() {
  "use cache";
  cacheLife("hours");
  // ...
}
```

### `cacheTag(...tags)`

Tag cache entries for selective invalidation.

**Example:**

```typescript
import { cacheTag } from "next/cache";

async function MyComponent({ id }: { id: string }) {
  "use cache";
  cacheTag("my-data", `item:${id}`);
  // ...
}
```

### `revalidateTag(tag)`

Invalidate all cache entries with a specific tag.

**Example:**

```typescript
import { revalidateTag } from "next/cache";

// In an API route
export async function POST() {
  revalidateTag("my-data");
  return Response.json({ revalidated: true });
}
```

### `revalidatePath(path)`

Invalidate all cache entries for a specific path.

**Example:**

```typescript
import { revalidatePath } from "next/cache";

// In an API route
export async function POST() {
  revalidatePath("/products");
  return Response.json({ revalidated: true });
}
```

## Cache Directives

### `"use cache"`

Mark a component for caching.

```typescript
async function MyComponent() {
  "use cache";
  // Component code
}
```

### `"use cache: remote"`

Mark for distributed caching across instances.

```typescript
async function MyComponent() {
  "use cache: remote";
  // Component code
}
```
