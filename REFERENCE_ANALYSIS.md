# Old NextJS Cache Handler Implementation - Comprehensive Analysis

## 1. PACKAGE STRUCTURE

### Single Monolithic Package
- **Package Name**: `@fortedigital/nextjs-cache-handler` (v2.1.7)
- **Type**: ES Module with CommonJS exports
- **Node Version**: >= 22.0.0
- **Next.js**: >= 15.2.4 (peer dependency)

### Export Strategy
```
Main: ./dist/handlers/cache-handler.{js,cjs}
Wildcard: ./dist/handlers/*.{js,cjs}
Instrumentation: ./dist/instrumentation/instrumentation.{js,cjs}
Redis Cluster Adapter: ./dist/helpers/redisClusterAdapter.{js,cjs}
Abort Signal Helpers: ./dist/helpers/withAbortSignal.{js,cjs}
                     ./dist/helpers/withAbortSignalProxy.{js,cjs}
```

### Code Organization
```
packages/nextjs-cache-handler/src/
├── handlers/
│   ├── cache-handler.ts          # Main handler orchestrator
│   ├── cache-handler.types.ts    # Core type definitions
│   ├── redis-strings.ts          # Redis implementation
│   ├── redis-strings.types.ts    # Redis-specific types
│   ├── local-lru.ts              # In-memory LRU implementation
│   ├── local-lru.types.ts        # LRU configuration types
│   ├── composite.ts              # Multi-handler router
│   └── composite.types.ts        # Composite configuration
├── helpers/
│   ├── buffer.ts                 # Buffer/string conversion (Next.js 15 compat)
│   ├── const.ts                  # Constants (implicit tag prefix)
│   ├── withAbortSignal.ts        # Timeout/abort handling
│   ├── withAbortSignalProxy.ts   # Proxy wrapper for abort signals
│   ├── redisClusterAdapter.ts    # Redis Cluster compatibility
│   ├── getTagsFromHeaders.ts     # Extract tags from x-next-cache-tags header
│   ├── isImplicitTag.ts          # Check implicit vs explicit tags
│   ├── resolveRevalidateValue.ts # Extract revalidate from cache entry
│   └── createValidatedAgeEstimationFunction.ts  # TTL validation
├── instrumentation/
│   ├── instrumentation.ts        # Entry point
│   └── register-initial-cache.ts # Pre-warm cache on startup
└── constants.ts                  # __revalidated_tags__ constant
```

---

## 2. KEY FEATURES IMPLEMENTED

### Core Handler Interface
Every handler implements this interface:
```typescript
type Handler = {
  name: string;
  get(key: string, meta: HandlerGetMeta): Promise<CacheHandlerValue | null>;
  set(key: string, value: CacheHandlerValue): Promise<void>;
  revalidateTag(tag: string): Promise<void>;
  delete?(key: string): Promise<void>; // Optional
};
```

### A. Redis Handler (`redis-strings`)

**Purpose**: Distributed cache for production deployments

**Features**:
- Redis Strings for cache values (JSON serialized)
- Shared tags stored in Redis Hash: `{keyPrefix}__sharedTags__`
- Shared TTLs stored in Redis Hash: `{keyPrefix}__sharedTagsTtl__`
- Implicit tags tracked in: `{keyPrefix}__revalidated_tags__`
- Key expiration via `EXAT` or `EXPIREAT` strategy
- Configurable timeouts with AbortSignal

**Configuration**:
```typescript
interface CreateRedisStringsHandlerOptions {
  client: RedisClientType | RedisClusterCacheAdapter;
  keyPrefix?: string;  // Default: ''
  sharedTagsKey?: string;  // Default: '__sharedTags__'
  sharedTagsTtlKey?: string;  // Default: '__sharedTagsTtl__'
  timeoutMs?: number;  // Default: 5000
  keyExpirationStrategy?: 'EXAT' | 'EXPIREAT';  // Default: 'EXPIREAT'
  revalidateTagQuerySize?: number;  // Default: 10_000
}
```

**Critical Behaviors**:
- Uses `hScan` with cursor iteration to avoid memory issues
- Implicit tags stored with millisecond timestamps (Date.now())
- On get: checks if shared tag exists; if not, deletes stale entry
- On revalidate: async batch delete operations
- On revalidateTag: calls both revalidateTag() and revalidateSharedKeys()
- Converts Buffers to base64 strings for Redis storage

**Redis Cluster Support**:
- `withAdapter()` wraps cluster to add `isReady` property
- Checks all replicas are ready: `cluster.replicas.every(s => s.client?.isReady)`

### B. LRU Handler (`local-lru`)

**Purpose**: In-memory cache for development/fallback

**Features**:
- LRU eviction when max items or max size reached
- Size calculation based on JSON.stringify length
- Implicit tag revalidation tracking
- No deletion of expired entries (relies on handler expiry check)

**Configuration**:
```typescript
interface LruCacheOptions {
  maxItemsNumber?: number;  // Default: 1000
  maxItemSizeBytes?: number;  // Default: 100MB (104857600)
}
```

**Critical Behaviors**:
- Get checks all tags (explicit + implicit) against revalidation times
- Deletes entry if ANY tag was revalidated after lastModified
- Revalidate stores tag with current timestamp

### C. Composite Handler (`composite`)

**Purpose**: Route operations across multiple handlers (L1/L2 caching)

**Features**:
- First-match read strategy (tries handlers in order)
- Custom set strategy function to choose handler
- Parallel revalidate/delete across all handlers

**Configuration**:
```typescript
interface CreateCompositeHandlerOptions {
  handlers: Handler[];
  setStrategy?: (data: CacheHandlerValue) => number;  // Returns handler index
}
```

**Example Use Cases**:
- Memory cache for "memory-cache" tagged entries, Redis for others
- L1: LRU (fast), L2: Redis (persistent)

---

## 3. IMPORTANT IMPLEMENTATION DETAILS

### Cache Value Structure
```typescript
type CacheHandlerValue = {
  lastModified: number;  // milliseconds
  tags: Readonly<string[]>;  // Extracted from headers or context
  lifespan: LifespanParameters | null;  // TTL info
  value: IncrementalCacheValue;  // The actual cached data
};

type LifespanParameters = {
  lastModifiedAt: number;  // seconds (Unix)
  staleAt: number;  // seconds (Unix)
  expireAt: number;  // seconds (Unix)
  staleAge: number;  // seconds
  expireAge: number;  // seconds
  revalidate: false | number;  // original revalidate value
};
```

### Tag Handling

**Implicit Tags** (system-generated):
- Prefix: `_N_T_` (NEXT_CACHE_IMPLICIT_TAG_ID)
- Examples: `_N_T_/page`, `_N_T_/layout`
- Special handling: timestamp-based revalidation
- Stored separately in `__revalidated_tags__` hash

**Explicit Tags** (user-defined):
- Extracted from `x-next-cache-tags` header (comma-separated)
- Example: `x-next-cache-tags: products,homepage`
- Standard tag revalidation (delete all keyed entries with tag)

### Buffer/String Conversion (Next.js 15 Compatibility)

**APP_ROUTE kind**:
- `body: Buffer` → base64 string on save
- base64 string → Buffer on read

**APP_PAGE kind**:
- `rscData: Buffer` → base64 string on save
- base64 string → Buffer on read
- `segmentData: Map<string, Buffer>` → Record<string, string> on save
- Record → Map on read

### TTL Management

**Default Stale Age**: 1 year (31536000 seconds)

**Expire Age Calculation**:
```typescript
function getInitialExpireAge(staleAge: number): number {
  return staleAge * 1.5;  // 1.5x multiplier
}
```

**Custom Function Support**:
```typescript
{
  ttl?: {
    defaultStaleAge?: number;
    estimateExpireAge?: (staleAge: number) => number;
  }
}
```

**Validation**:
- Must be positive integer
- Must be ≤ 2147483647 (MAX_INT32)
- Throws assertion error if invalid

### Timeout/Abort Handling

**AbortSignal Proxy**:
- Wraps Redis client to inject abort signals
- Every operation has configurable timeout
- `AbortSignal.timeout(timeoutMs)` used throughout
- Default: 5 seconds

**Error Handling**:
- "Aborted" if signal already aborted
- "Operation aborted" if signal aborted during execution
- Promise rejects with error, not silently fails

### Connection Management

**Redis Client**:
- Creates single global instance (stored in global scope)
- Checks `client.isReady` before operations
- Error event resets global config
- Graceful degradation to LRU on Redis failure

**Single Connection Mode**:
- Environment variable: `REDIS_SINGLE_CONNECTION`
- Ensures only one client created across hot reloads
- Uses global promise to coordinate initialization

### File System Fallback

**For Pages Router with `fallback: false`**:
- Reads from disk: `.next/server/pages/{route}.html` and `.json`
- Called during build phase if cache miss
- Automatically sets to cache handlers

**For Fetch Cache**:
- Writes to: `.next/cache/fetch-cache/{key}`
- Parallel to cache handlers
- Only during production build phase

---

## 4. TEST PATTERNS

### Test Framework
- **Jest** with `ts-jest`
- Colocated tests: `*.test.ts` next to source files

### Example: withAbortSignal Tests
Key patterns:
1. **Mock Promise Functions**: `jest.fn().mockResolvedValue/mockRejectedValue`
2. **AbortController API**: Standard Web API
3. **Event Listener Cleanup**: Verify `removeEventListener` called
4. **Edge Cases**: Already aborted, undefined signal, null signal
5. **Race Conditions**: Ensure promise resolves before abort

### Testing Strategy
- Unit tests for helpers and utilities
- Integration tests for handlers (mocked clients)
- Error paths and timeouts explicitly tested
- Memory leak prevention (listener cleanup)

---

## 5. NEXT.JS 16 SPECIFIC FEATURES

### "use cache" Directive Support
- Not explicitly mentioned in code
- Implicitly supported through standard cache handler interface
- Works via middleware that extracts tags from responses

### Cache Components
- Supported through `APP_PAGE` cache value kind
- `rscData` and `segmentData` for React Server Component output
- Headers contain cache control metadata

### Tag-Based Revalidation
- `revalidateTag(tag)` method
- Infrastructure for fast tag-based invalidation
- Both implicit and explicit tag support

### Time-Based Revalidation
- `revalidate` option from pages and routes
- Converted to `staleAt` and `expireAt` timestamps
- Handler responsible for TTL in storage

### Build-Time Caching
- `registerInitialCache()` instrumentation
- Pre-warms cache on application start
- Populates: pages, routes, fetch caches from disk

---

## 6. CRITICAL FUNCTIONALITY & EDGE CASES

### MUST NOT MISS Features:

**1. Implicit Tag Revalidation**
   - System uses timestamp-based tracking for implicit tags
   - Store separately from explicit tags
   - Check revalidation time on every get operation
   - Critical for ISR and On-Demand Revalidation

**2. Shared Tag Maps in Redis**
   - Cannot scale without TTL-bound hashmaps
   - Prevents memory leaks in long-running Redis instances
   - Uses cursor-based HSCAN to handle large datasets
   - `revalidateTagQuerySize` optimization is important

**3. Buffer/String Conversion**
   - Next.js 15+ changed body/rscData to Buffer
   - Must convert on both directions (save/load)
   - Uses base64 encoding for JSON serialization
   - Affects APP_ROUTE and APP_PAGE kinds

**4. AbortSignal Timeout Pattern**
   - Every Redis operation needs timeout
   - Not optional for production reliability
   - Event listener cleanup is critical (memory leak risk)
   - Race condition: abort vs resolve both possible

**5. Global Singleton Pattern**
   - Redis client must be singleton
   - Global promise coordination prevents race conditions
   - Error handling resets global state
   - Single connection mode for Next.js hot reload

**6. Fallback False Routes**
   - Pages Router with `fallback: false` needs special handling
   - Read from disk during build phase
   - Automatically cache the result
   - Required for correct 404 behavior

**7. Tag Extraction from Headers**
   - Header format: `x-next-cache-tags: tag1,tag2,...`
   - Can be array or comma-separated string
   - Extracting tags is handler responsibility (not core)
   - Critical for APP_PAGE cache invalidation

**8. Concurrent Operations**
   - Use `Promise.all()` for parallel operations
   - Use `Promise.allSettled()` for fault tolerance in multi-handler
   - Never stop entire handler on partial failure
   - Log all failures for debugging

**9. Debug Logging**
   - Enabled via `NEXT_PRIVATE_DEBUG_CACHE` environment variable
   - Structured format: `[CacheHandler] [handler: name] [method: op] [key: key] message`
   - Critical for production debugging
   - Must not impact performance when disabled

**10. Entry Expiration Check**
   - Check `expireAt < Math.floor(Date.now() / 1000)` on get
   - Delete stale entries in background (non-blocking)
   - Time comparison in SECONDS, not milliseconds
   - Critical for correctness with TTL-based storage

### Edge Cases to Handle:

1. **Redis Client Not Ready**: Check `isReady` before every operation
2. **Timeout Exceeds Operation**: Graceful failure with AbortError
3. **Handler Returns Null/Undefined**: Treat as cache miss
4. **No Lifespan (fallback: false pages)**: Cache forever (lifespan: null)
5. **Empty Tags Array**: Still valid, no revalidation
6. **Large Tag Maps**: HSCAN with cursor prevents blocking
7. **Stale Entry with Valid TTL**: Delete in background, return null
8. **Multiple Handlers Fail**: Continue to next handler gracefully
9. **setStrategy Returns Invalid Index**: Default to first handler
10. **Implicit Tag Prefix Mismatch**: Update NEXT_CACHE_IMPLICIT_TAG_ID constant

### Production-Ready Requirements:

- Timeouts on all external calls (Redis, file system)
- Proper error handling without throwing uncaught errors
- Graceful degradation (LRU fallback)
- Memory leak prevention (event listeners, cursor iteration)
- Debug logging support
- Single connection management
- Batch operations for scale (HSCAN for tags)
- Background cleanup of stale entries
- Type safety (strict TypeScript)
- Comprehensive JSDoc documentation

---

## 7. DECISION POINTS FOR NEW IMPLEMENTATION

### Key Architectural Decisions:

1. **Monolithic vs. Separate Packages**
   - Old: Single package with all handlers
   - Decision: Continue with monolithic approach for single package, offer separate packages for redis and elasticache

2. **Handler Interface Stability**
   - Keep Handler interface exactly as defined
   - Type compatibility is critical for ecosystem

3. **Redis Implementation Details**
   - Keep cursor-based HSCAN approach
   - Keep timeout pattern with AbortSignal
   - Keep base64 conversion for Buffer handling

4. **Testing Approach**
   - Use Vitest instead of Jest (per CLAUDE.md)
   - Keep unit test colocations
   - Add e2e tests with Docker Compose

5. **Error Handling**
   - Promise.allSettled for multi-handler operations
   - Explicit error logging (no silent failures)
   - Throw errors with descriptive messages

6. **Performance Optimization**
   - Batch operations (HSCAN, HDEL, DEL)
   - Parallel operations where possible
   - Never wait for all handlers in get (first match)

---

## Summary

This is a mature, production-ready implementation focused on:
- **Reliability**: Timeout handling, graceful degradation, error logging
- **Scale**: Cursor-based iteration, batch operations, memory management
- **Compatibility**: Buffer conversion, implicit tag tracking, file system fallback
- **Developer Experience**: Flexible composition, clear abstractions, comprehensive types

The new `better-nextjs-cache-handler` should preserve all these patterns while improving code organization, testing, and documentation.

