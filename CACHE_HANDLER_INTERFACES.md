# Next.js Cache Handler Interfaces

## Overview

Next.js 16 has **TWO COMPLETELY DIFFERENT** cache handler interfaces:

1. **ISR Cache Handler** (`cacheHandler`) - For Incremental Static Regeneration
2. **Data Cache Handler** (`experimental.cacheHandlers`) - For "use cache" directive

## 1. ISR Cache Handler (`cacheHandler`)

**Config**: `next.config.js` → `cacheHandler: './path/to/handler.js'`

**Used For**:
- Incremental Static Regeneration (ISR)
- Route handler responses
- Traditional page caching

**NOT Used For**:
- `"use cache"` directive ❌
- `"use cache: private"` ❌
- `"use cache: remote"` ❌

### Interface (What We Built)

```typescript
interface CacheHandler {
  name: string;

  get(key: string, meta?: CacheHandlerGetMeta): Promise<CacheValue | null>;

  set(key: string, value: CacheValue, context?: CacheHandlerContext): Promise<void>;

  revalidateTag(tag: string, profile?: string | { expire?: number }): Promise<void>;

  delete?(key: string): Promise<void>;
}

interface CacheValue {
  kind: "ROUTE" | "PAGE" | "FETCH" | "IMAGE";
  // ... kind-specific fields
}
```

## 2. Data Cache Handler (`experimental.cacheHandlers`)

**Config**: `next.config.js` → `experimental.cacheHandlers.default: './path/to/handler.js'`

**Requires**: `experimental.dynamicIO: true`

**Used For**:
- `"use cache"` directive ✅
- `"use cache: remote"` ✅
- Dynamic data caching with cache components

### Interface (From Next.js Source)

Source: `packages/next/src/server/lib/cache-handlers/types.ts`

```typescript
interface CacheHandler {
  /**
   * Retrieve a cache entry for the given cache key, if available. Will return
   * undefined if there's no valid entry, or if the given soft tags are stale.
   */
  get(cacheKey: string, softTags: string[]): Promise<undefined | CacheEntry>;

  /**
   * Store a cache entry for the given cache key. When this is called, the entry
   * may still be pending, i.e. its value stream may still be written to. So it
   * needs to be awaited first. If a `get` for the same cache key is called,
   * before the pending entry is complete, the cache handler must wait for the
   * `set` operation to finish, before returning the entry, instead of returning
   * undefined.
   */
  set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void>;

  /**
   * This function may be called periodically, but always before starting a new
   * request. If applicable, it should communicate with the tags service to
   * refresh the local tags manifest accordingly.
   */
  refreshTags(): Promise<void>;

  /**
   * This function is called for each set of soft tags that are relevant at the
   * start of a request. The result is the maximum timestamp of a revalidate
   * event for the tags. Returns `0` if none of the tags were ever revalidated.
   * Returns `Infinity` if the soft tags are supposed to be passed into the
   * `get` method instead to be checked for expiration.
   */
  getExpiration(tags: string[]): Promise<Timestamp>;

  /**
   * This function is called when tags are revalidated/expired. If applicable,
   * it should update the tags manifest accordingly.
   */
  updateTags(tags: string[], durations?: { expire?: number }): Promise<void>;
}

interface CacheEntry {
  /**
   * The ReadableStream can error and only have partial data so any cache
   * handlers need to handle this case and decide to keep the partial cache
   * around or not.
   */
  value: ReadableStream<Uint8Array>;

  /**
   * The tags configured for the entry excluding soft tags
   */
  tags: string[];

  /**
   * This is for the client, not used to calculate cache entry expiration
   * [duration in seconds]
   */
  stale: number;

  /**
   * When the cache entry was created [timestamp in milliseconds]
   */
  timestamp: Timestamp;

  /**
   * How long the entry is allowed to be used (should be longer than revalidate)
   * [duration in seconds]
   */
  expire: number;

  /**
   * How long until the entry should be revalidated [duration in seconds]
   */
  revalidate: number;
}

type Timestamp = number; // milliseconds since epoch
```

## Key Differences

| Feature | ISR Handler | Data Cache Handler |
|---------|-------------|-------------------|
| **get() signature** | `get(key, meta?)` | `get(cacheKey, softTags)` |
| **set() signature** | `set(key, value, context?)` | `set(cacheKey, Promise<entry>)` |
| **Value type** | Structured objects (ROUTE/PAGE/FETCH/IMAGE) | `ReadableStream<Uint8Array>` |
| **Tag management** | `revalidateTag(tag, profile?)` | `updateTags(tags, durations?)` + `getExpiration(tags)` |
| **Tag refresh** | N/A | `refreshTags()` required |
| **Async handling** | Synchronous value | **Pending promise** for streaming |
| **Cache key** | Generic string | String (from hash of cached function) |
| **Soft tags** | Not supported | Passed to `get()` for dynamic checking |

## Configuration Example

```typescript
// next.config.ts
import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig = {
  // Enable cache components (required for "use cache")
  cacheComponents: true,

  // Disable default in-memory cache for "use cache"
  cacheMaxMemorySize: 0,

  // ISR cache handler (old system)
  cacheHandler: path.join(__dirname, './cache-handler-isr.mjs'),

  experimental: {
    // Enable dynamic IO (required for data cache handlers)
    dynamicIO: true,

    // Data cache handler for "use cache" directive
    cacheHandlers: {
      default: path.join(__dirname, './cache-handler-data.mjs'),
    },
  },
};

export default nextConfig;
```

## Implementation Strategy

### Option A: Build Both Handlers ✅ (Recommended)

Create two separate packages:
1. `@mrjasonroy/better-nextjs-cache-handler` - ISR handler (what we built)
2. `@mrjasonroy/better-nextjs-data-cache-handler` - Data cache handler (new)

**Pros**:
- Clear separation of concerns
- Users can use one or both
- Each handler optimized for its use case

### Option B: Unified Package with Two Exports

Single package with both handlers:
```typescript
import { createISRCacheHandler } from '@mrjasonroy/better-nextjs-cache-handler/isr';
import { createDataCacheHandler } from '@mrjasonroy/better-nextjs-cache-handler/data';
```

**Pros**:
- Single installation
- Shared utilities (LRU, buffer helpers, etc.)

### Option C: Adapter Pattern

Build data cache handler as wrapper around ISR handler with conversion logic.

**Pros**:
- Code reuse
- Single implementation

**Cons**:
- Performance overhead from conversion
- Complexity of streaming adaptation

## Next Steps

1. ✅ Document both interfaces (this file)
2. Decide on implementation strategy
3. Implement data cache handler for "use cache"
4. Update E2E tests to test both handlers
5. Update documentation to clarify which handler is for what

## References

- ISR Cache Handler: `next.js/packages/next/src/server/lib/incremental-cache/`
- Data Cache Handler: `next.js/packages/next/src/server/lib/cache-handlers/`
- Default Data Handler: `next.js/packages/next/src/server/lib/cache-handlers/default.ts`
