# Complete Next.js 16 Cache Handler Architecture

## Executive Summary

Next.js 16 has **TWO completely separate caching systems**:

1. **ISR Cache** (`cacheHandler`) - For Incremental Static Regeneration
2. **Data Cache** (`cacheHandlers`) - For "use cache" directive

This package provides handlers for **BOTH** systems, making it a complete caching solution for Next.js 16.

## 1. ISR Cache System (`cacheHandler`)

### What It's For
- Incremental Static Regeneration (ISR)
- Route handler responses
- Traditional Next.js page caching
- **NOT used by "use cache" directive**

### Configuration
```javascript
// next.config.js
module.exports = {
  cacheHandler: require.resolve('./isr-cache-handler.mjs')
}
```

### Handler Interface
```typescript
interface CacheHandler {
  name: string;
  get(key: string, meta?: CacheHandlerGetMeta): Promise<CacheValue | null>;
  set(key: string, value: CacheValue, context?: CacheHandlerContext): Promise<void>;
  revalidateTag(tag: string, profile?: string | { expire?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
}
```

### Available Handlers
- `MemoryCacheHandler` - LRU memory cache
- `CompositeHandler` - Multi-tier caching

### Example
```javascript
// isr-cache-handler.mjs
import { MemoryCacheHandler } from '@mrjasonroy/better-nextjs-cache-handler';

export default class ISRHandler extends MemoryCacheHandler {
  constructor(options) {
    super({
      ...options,
      maxItemsNumber: 1000,
      defaultTTL: 3600
    });
  }
}
```

## 2. Data Cache System (`cacheHandlers`)

### What It's For
- `"use cache"` directive
- `"use cache: remote"` directive
- `"use cache: private"` directive
- Custom cache kinds (any name you want)

### Configuration
```javascript
// next.config.js
module.exports = {
  cacheComponents: true,
  cacheMaxMemorySize: 0, // Disable default in-memory
  cacheHandlers: {
    default: require.resolve('./default-cache-handler.mjs'),
    remote: require.resolve('./redis-cache-handler.mjs'),
    custom: require.resolve('./custom-cache-handler.mjs')
  }
}
```

### Handler Interface
```typescript
interface DataCacheHandler {
  get(cacheKey: string, softTags: string[]): Promise<undefined | DataCacheEntry>;
  set(cacheKey: string, pendingEntry: Promise<DataCacheEntry>): Promise<void>;
  refreshTags(): Promise<void>;
  getExpiration(tags: string[]): Promise<number>;
  updateTags(tags: string[], durations?: { expire?: number }): Promise<void>;
}

interface DataCacheEntry {
  value: ReadableStream<Uint8Array>;  // Streaming support!
  tags: string[];
  stale: number;
  timestamp: number;
  expire: number;
  revalidate: number;
}
```

### Key Differences from ISR Cache
- **Streaming**: Uses `ReadableStream<Uint8Array>` instead of structured objects
- **Async set**: Receives `Promise<DataCacheEntry>` for async operations
- **Tag management**: Separate `refreshTags()`, `getExpiration()`, and `updateTags()`
- **Soft tags**: Dynamic tags passed to `get()` method

### Available Handlers
- `createMemoryDataCacheHandler()` - In-memory LRU cache
- `createRedisDataCacheHandler()` - Redis-based distributed cache

### Memory Handler Example
```javascript
// default-cache-handler.mjs
import { createMemoryDataCacheHandler } from '@mrjasonroy/better-nextjs-cache-handler';

export default createMemoryDataCacheHandler({
  maxSize: 100 * 1024 * 1024, // 100MB
  debug: true
});
```

### Redis Handler Example
```javascript
// redis-cache-handler.mjs
import { createClient } from 'redis';
import { createRedisDataCacheHandler } from '@mrjasonroy/better-nextjs-cache-handler';

const redis = createClient({
  url: process.env.REDIS_URL
});

await redis.connect();

export default createRedisDataCacheHandler({
  redis,
  keyPrefix: 'myapp:cache:',
  tagPrefix: 'myapp:tags:',
  defaultTTL: 86400, // 24 hours
  debug: process.env.NODE_ENV === 'development'
});
```

## 3. Using Cache Directives

### Standard Caching (`"use cache"`)
Uses the `default` handler:

```typescript
async function MyComponent() {
  "use cache";

  const data = await fetchData();
  return <div>{data}</div>;
}
```

### Remote Caching (`"use cache: remote"`)
Uses the `remote` handler (ideal for distributed deployments):

```typescript
async function SharedData() {
  "use cache: remote";

  const data = await fetchSharedData();
  return <div>{data}</div>;
}
```

### Custom Cache Kinds
You can define ANY custom kind:

```typescript
// next.config.js
cacheHandlers: {
  'session': require.resolve('./session-cache.mjs'),
  'api': require.resolve('./api-cache.mjs')
}

// In your code
async function SessionData() {
  "use cache: session";
  // Uses session cache handler
}

async function APIData() {
  "use cache: api";
  // Uses API cache handler
}
```

## 4. Complete Configuration Example

```javascript
// next.config.js
import path from 'path';

export default {
  // Enable cache components (required for "use cache")
  cacheComponents: true,

  // Disable default in-memory caching
  cacheMaxMemorySize: 0,

  // ISR Cache Handler (for traditional caching)
  cacheHandler: path.resolve('./handlers/isr-handler.mjs'),

  // Data Cache Handlers (for "use cache")
  cacheHandlers: {
    default: path.resolve('./handlers/memory-cache.mjs'),
    remote: path.resolve('./handlers/redis-cache.mjs'),
  }
};
```

## 5. How Next.js Loads Handlers

### ISR Handler
1. Loaded via `getIncrementalCache()` method
2. Dynamically imported from path in `cacheHandler` config
3. Instantiated as a class with `new CacheHandler(options)`

### Data Cache Handlers
1. Loaded via `loadCustomCacheHandlers()` method
2. Dynamically imported from paths in `cacheHandlers` config
3. **Exported as instances** (not classes)
4. Registered by kind using `setCacheHandler(kind, handler)`
5. Stored in global Map keyed by kind name

## 6. Cache Handler Lifecycle

### ISR Cache
```
Request → getIncrementalCache() → new CacheHandler(options) → handler instance
```

### Data Cache
```
Server Start → loadCustomCacheHandlers() →
  → Dynamic import handlers →
  → initializeCacheHandlers(maxSize) →
  → setCacheHandler('default', defaultHandler) →
  → setCacheHandler('remote', remoteHandler) →
  → Handlers stored in global Map

Runtime → "use cache: remote" →
  → getCacheHandler('remote') →
  → Use remote handler
```

## 7. Built-in vs Custom Kinds

### Built-in Kinds
- `default` - Used by `"use cache"`
- `remote` - Used by `"use cache: remote"`

### Custom Kinds
You can define unlimited custom kinds:

```javascript
cacheHandlers: {
  'user-session': './user-session-cache.mjs',
  'api-responses': './api-cache.mjs',
  'static-content': './static-cache.mjs',
  'personalized': './personalized-cache.mjs'
}
```

Then use them:
```typescript
"use cache: user-session"
"use cache: api-responses"
"use cache: static-content"
"use cache: personalized"
```

## 8. Production Recommendations

### For Single Server
```javascript
cacheHandlers: {
  default: './memory-cache.mjs',  // Fast in-memory
  remote: './memory-cache.mjs'   // Same handler is fine
}
```

### For Multi-Server / Distributed
```javascript
cacheHandlers: {
  default: './memory-cache.mjs',  // Fast local cache for non-critical data
  remote: './redis-cache.mjs'     // Shared Redis for critical data
}
```

### For Serverless (Vercel, etc.)
```javascript
cacheHandlers: {
  default: './vercel-kv-cache.mjs',  // Use platform cache
  remote: './vercel-kv-cache.mjs'
}
```

## 9. Key Insights from Next.js Source

### From `packages/next/src/server/use-cache/handlers.ts`:
- Handlers stored globally using Symbols
- Only 2 built-in kinds: `default` and `remote`
- Falls back to default handler if remote not configured
- Uses Map for O(1) handler lookup by kind

### From `packages/next/src/server/next-server.ts`:
- ISR and Data caches loaded separately
- Data cache handlers dynamically imported at server start
- Supports any number of custom kinds
- Handler registration happens before first request

## 10. Common Patterns

### Pattern 1: Same Handler for All Kinds
```javascript
const handler = './redis-cache.mjs';
cacheHandlers: {
  default: handler,
  remote: handler,
  custom: handler
}
```

### Pattern 2: Tiered Caching
```javascript
cacheHandlers: {
  default: './memory-cache.mjs',    // Fast, volatile
  remote: './redis-cache.mjs',      // Shared, persistent
  cdn: './cdn-cache.mjs'           // Edge, global
}
```

### Pattern 3: Purpose-Specific
```javascript
cacheHandlers: {
  default: './default-cache.mjs',
  'user-data': './user-cache.mjs',      // User-specific TTLs
  'static-assets': './static-cache.mjs',  // Long TTLs
  'api-calls': './api-cache.mjs'       // API-specific logic
}
```

## 11. Testing Strategy

1. **Unit Test Handlers**: Test get/set/revalidate independently
2. **Integration Test with Next.js**: Test with actual "use cache" directives
3. **E2E Test Cache Behavior**: Verify caching works end-to-end
4. **Load Test**: Ensure handlers perform under load
5. **Failover Test**: Test Redis connection failures

## Summary

This package provides **complete Next.js 16 caching support**:

- ✅ ISR Cache Handlers (memory, composite)
- ✅ Data Cache Handlers (memory, Redis)
- ✅ Support for all cache kinds (default, remote, custom)
- ✅ Production-ready implementations
- ✅ Streaming support
- ✅ Tag-based revalidation
- ✅ Distributed caching with Redis

Choose the right handlers for your deployment:
- **Development**: Memory handlers
- **Production (single server)**: Memory handlers
- **Production (multi-server)**: Redis handlers
- **Serverless**: Platform-specific handlers
