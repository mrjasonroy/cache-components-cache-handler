# @mrjasonroy/cache-components-cache-handler

Modern cache handler for Next.js 16+ with support for the `"use cache"` directive and cache components.

## Features

- ✅ **Next.js 16+ only** - Built specifically for the new caching system
- ✅ **TypeScript** - Full type safety with strict mode
- ✅ **In-memory LRU** - Fast, production-ready memory caching
- ✅ **Composite handler** - Multi-tier caching strategies
- ✅ **Tag-based revalidation** - Both explicit and implicit tags
- ✅ **TTL support** - Time-based expiration
- ✅ **Zero dependencies** - Lightweight and fast
- ✅ **Comprehensive tests** - 31 tests, 100% coverage

## Installation

```bash
npm install @mrjasonroy/cache-components-cache-handler
# or
pnpm add @mrjasonroy/cache-components-cache-handler
# or
yarn add @mrjasonroy/cache-components-cache-handler
```

## Quick Start

### Setup for Next.js 16

Next.js 16 has **two separate cache systems**:
1. **ISR Cache** (`cacheHandler`) - For Incremental Static Regeneration
2. **Data Cache** (`cacheHandlers`) - For `"use cache"` and `"use cache: remote"`

Use the helper function to configure both easily:

```typescript
// next.config.mjs
import { createCacheConfig } from "@mrjasonroy/cache-components-cache-handler";
import { resolve } from "path";

const cacheConfig = createCacheConfig({
  isrHandlerPath: resolve(process.cwd(), "./cache-handler.mjs"),
  dataCacheHandlerPath: resolve(process.cwd(), "./data-cache-handler.mjs"),
});

export default {
  cacheComponents: true, // Enable cache components
  ...cacheConfig,
  // Rest of your Next.js config
};
```

Then create your cache handler files:

```javascript
// cache-handler.mjs (ISR Cache)
import { createMemoryCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

export default createMemoryCacheHandler({
  maxItemsNumber: 1000,
  maxItemSizeBytes: 100 * 1024 * 1024, // 100MB
});
```

```javascript
// data-cache-handler.mjs (Data Cache for "use cache")
import { createMemoryDataCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

export default createMemoryDataCacheHandler({
  ttl: 3600, // 1 hour default
});
```

### Multi-Tier Caching

```typescript
// next.config.js
import {
  createMemoryCacheHandler,
  createCompositeHandler,
} from "@mrjasonroy/cache-components-cache-handler";

const memoryHandler = createMemoryCacheHandler({
  maxItemsNumber: 100, // Small L1 cache
});

const redisHandler = createRedisHandler({
  // Your Redis handler implementation
});

export default {
  cacheHandler: createCompositeHandler({
    handlers: [memoryHandler, redisHandler],
    // Optional: route based on tags
    setStrategy: (data) => {
      if (data.tags.includes("memory-only")) {
        return 0; // Use memory handler
      }
      return 1; // Use Redis handler
    },
  }),
};
```

## API Reference

### `createCacheConfig(options)`

Helper function to generate Next.js 16 cache configuration for both ISR and Data Cache.

**Options:**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `isrHandlerPath` | `string` | Yes | Path to ISR cache handler file |
| `dataCacheHandlerPath` | `string` | Yes | Path to data cache handler file |
| `disableDefaultMemoryCache` | `boolean` | No | Disable Next.js default memory cache (default: `true`) |

**Returns:**

```typescript
{
  cacheHandler: string;                    // ISR cache handler path
  cacheHandlers: {
    default: string;                       // "use cache" handler path
    remote: string;                        // "use cache: remote" handler path
  };
  cacheMaxMemorySize?: number;            // 0 if disableDefaultMemoryCache is true
}
```

**Example:**

```typescript
import { createCacheConfig } from "@mrjasonroy/cache-components-cache-handler";
import { resolve } from "path";

const cacheConfig = createCacheConfig({
  isrHandlerPath: resolve(process.cwd(), "./cache-handler.mjs"),
  dataCacheHandlerPath: resolve(process.cwd(), "./data-cache-handler.mjs"),
});

export default {
  cacheComponents: true,
  ...cacheConfig,
};
```

### `createCacheConfigWithProfiles(options)`

Advanced helper for using different cache handlers for `default` and `remote` profiles.

**Options:**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `isrHandlerPath` | `string` | Yes | Path to ISR cache handler file |
| `defaultDataCacheHandlerPath` | `string` | Yes | Path for "use cache" (fast, local) |
| `remoteDataCacheHandlerPath` | `string` | Yes | Path for "use cache: remote" (DB, API) |
| `disableDefaultMemoryCache` | `boolean` | No | Disable Next.js default memory cache (default: `true`) |

**Example:**

```typescript
const cacheConfig = createCacheConfigWithProfiles({
  isrHandlerPath: resolve(process.cwd(), "./cache-handler.mjs"),
  defaultDataCacheHandlerPath: resolve(process.cwd(), "./data-cache-memory.mjs"),
  remoteDataCacheHandlerPath: resolve(process.cwd(), "./data-cache-redis.mjs"),
});
```

### `createMemoryCacheHandler(options?)`

Creates an in-memory LRU cache handler.

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxItemsNumber` | `number` | `1000` | Maximum number of items to store |
| `maxItemSizeBytes` | `number` | `104857600` (100MB) | Maximum size per item |
| `defaultTTL` | `number` | `undefined` | Default TTL in seconds |

**Features:**

- LRU eviction when max size exceeded
- Automatic expiration based on TTL
- Tag-based revalidation (explicit and implicit)
- Size-based rejection of oversized entries

**Example:**

```typescript
const handler = createMemoryCacheHandler({
  maxItemsNumber: 500,
  maxItemSizeBytes: 50 * 1024 * 1024, // 50MB
  defaultTTL: 1800, // 30 minutes
});
```

### `createCompositeHandler(options)`

Creates a composite handler that orchestrates multiple cache handlers.

**Options:**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `handlers` | `CacheHandler[]` | Yes | Array of handlers (ordered by priority) |
| `setStrategy` | `(data) => number` | No | Function to choose which handler to use for writes |

**Features:**

- First-match read strategy (tries handlers in order)
- Configurable write strategy
- Fault tolerance with `Promise.allSettled()`
- Parallel revalidation across all handlers

**Example:**

```typescript
const composite = createCompositeHandler({
  handlers: [memoryHandler, redisHandler],
  setStrategy: (data) => {
    // Cache small items in memory, large items in Redis
    const size = JSON.stringify(data).length;
    return size < 10000 ? 0 : 1;
  },
});
```

## Advanced Usage

### Tag-Based Revalidation

```typescript
// app/page.tsx
export default async function Page() {
  "use cache";
  // This component will be cached with implicit tags
  return <div>Cached content</div>;
}

// app/api/revalidate/route.ts
import { revalidateTag } from "next/cache";

export async function POST(request: Request) {
  const { tag } = await request.json();
  revalidateTag(tag);
  return Response.json({ revalidated: true });
}
```

### Time-Based Revalidation

```typescript
// app/page.tsx
export default async function Page() {
  "use cache";
  export const revalidate = 3600; // Revalidate after 1 hour

  return <div>Cached for 1 hour</div>;
}
```

### Custom Cache Tags

```typescript
// app/actions.ts
"use server";

import { unstable_cache } from "next/cache";

export const getData = unstable_cache(
  async () => {
    return fetch("https://api.example.com/data").then((res) => res.json());
  },
  ["api-data"],
  {
    tags: ["api-data", "user-data"],
    revalidate: 3600,
  },
);
```

## How It Works

### Implicit vs Explicit Tags

Next.js 16 uses two types of tags:

1. **Explicit tags** - User-defined tags (e.g., `["user-123", "posts"]`)
2. **Implicit tags** - System-generated tags with `_N_T_` prefix for ISR

The handler tracks both types separately for efficient revalidation.

### LRU Eviction

When the cache reaches `maxItemsNumber`:

1. The oldest (least recently used) entry is evicted
2. Entries are moved to the end on each access
3. New entries are always added at the end

### TTL Expiration

Entries can expire based on:

1. `revalidate` value in cache context (seconds)
2. `defaultTTL` if no revalidate specified
3. Never expire if `revalidate: false`

Expiration is checked on every `get()` call (lazy expiration).

## Type Definitions

```typescript
interface CacheHandler {
  name: string;
  get(key: string, meta?: CacheHandlerGetMeta): Promise<CacheValue | null>;
  set(key: string, value: CacheValue, context?: CacheHandlerContext): Promise<void>;
  revalidateTag(tag: string): Promise<void>;
  delete?(key: string): Promise<void>;
}

interface CacheHandlerContext {
  tags?: string[];
  revalidate?: number | false;
  softTags?: string[];
}

interface CacheHandlerGetMeta {
  implicitTags: string[];
}
```

## Testing

```bash
# Run tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run with coverage
pnpm test --coverage
```

## Performance

The memory handler is optimized for production use:

- Native `Map` for O(1) lookups
- Minimal overhead per cache entry
- Zero dependencies
- Fast expiration checks
- Efficient LRU implementation

Benchmark (1000 items, 1KB each):

- Set: ~0.01ms per item
- Get: ~0.005ms per item
- Memory usage: ~1MB + cache data

## Migration from Other Handlers

### From Next.js Built-in Cache

```diff
// next.config.js
+ import { createMemoryCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

export default {
+  cacheHandler: createMemoryCacheHandler(),
};
```

### From Custom Redis Handler

```diff
// next.config.js
import {
  createMemoryCacheHandler,
+  createCompositeHandler,
} from "@mrjasonroy/cache-components-cache-handler";
import { createRedisHandler } from "./redis-handler";

export default {
-  cacheHandler: createRedisHandler(),
+  cacheHandler: createCompositeHandler({
+    handlers: [
+      createMemoryCacheHandler({ maxItemsNumber: 100 }), // L1 cache
+      createRedisHandler(), // L2 cache
+    ],
+  }),
};
```

## Troubleshooting

### Cache not working

1. Check Next.js version (requires 16.0.0+)
2. Verify `"use cache"` directive is at top of component/function
3. Check browser/server console for errors

### Memory usage too high

1. Reduce `maxItemsNumber`
2. Reduce `maxItemSizeBytes`
3. Add TTL with `defaultTTL`
4. Use composite handler with Redis for large caches

### Revalidation not working

1. Verify tags are correctly defined
2. Check `revalidateTag()` is called on server
3. Ensure implicit tags are passed to `get()`

## Contributing

This project is part of a monorepo. See the main [README](../../README.md) for contribution guidelines.

## License

MIT © Jason Roy

## Support

- [GitHub Issues](https://github.com/mrjasonroy/cache-components-cache-handler/issues)
- [Documentation](https://github.com/mrjasonroy/cache-components-cache-handler)

## Related

- [Next.js 16 Cache Documentation](https://nextjs.org/docs/app/getting-started/cache-components)
- [@mrjasonroy/cache-components-cache-handler-redis](../cache-handler-redis) - Redis implementation
