# API Reference

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
  keyPrefix?: string;         // Prefix for cache keys (default: "nextjs:cache:")
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
