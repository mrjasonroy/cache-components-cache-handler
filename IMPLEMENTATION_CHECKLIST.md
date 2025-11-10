# Implementation Checklist: Porting Old to New

Use this checklist to ensure no critical features are missed when implementing `better-nextjs-cache-handler`.

## Core Types & Interfaces

- [ ] `Handler` interface with name, get, set, revalidateTag, delete?
- [ ] `HandlerGetMeta` with implicitTags array
- [ ] `CacheHandlerValue` with lastModified, tags, lifespan, value
- [ ] `LifespanParameters` with all TTL fields (lastModifiedAt, staleAt, expireAt, staleAge, expireAge, revalidate)
- [ ] `OnCreationHook` for configuration callback
- [ ] `CacheCreationContext` with serverDistDir, dev, buildId
- [ ] Separate export strategy for: main handler, instrumentation, cluster adapter, helpers

## CacheHandler Class

- [ ] Static onCreation(hook) method
- [ ] Static name property (shows handler count)
- [ ] Constructor accepting FileSystemCacheContext
- [ ] get() method with expiration check
- [ ] set() method with lifespan calculation
- [ ] revalidateTag() with implicit tag handling
- [ ] Lazy initialization via #configureCacheHandler()
- [ ] Global singleton pattern with race condition protection
- [ ] Read prerender-manifest.json for fallback:false routes
- [ ] Build ID detection from .next/BUILD_ID
- [ ] Debug logging via NEXT_PRIVATE_DEBUG_CACHE environment variable

## Redis Handler (redis-strings)

- [ ] Configuration options: client, keyPrefix, sharedTagsKey, sharedTagsTtlKey, timeoutMs, keyExpirationStrategy, revalidateTagQuerySize
- [ ] AbortSignal timeout pattern on every operation
- [ ] Buffer/string conversion (base64 encoding)
- [ ] Shared tag storage in Redis Hash
- [ ] Shared TTL storage in separate Hash
- [ ] Implicit tag revalidation timestamps
- [ ] Cursor-based HSCAN iteration (prevents memory leaks)
- [ ] isReady check before operations
- [ ] Error on unready client
- [ ] Two expiration strategies: EXAT and EXPIREAT
- [ ] Parallel batch operations (set tags + TTL + value)
- [ ] Background deletion of expired entries
- [ ] revalidateSharedKeys() to clean stale entries
- [ ] Both revalidateTag() and revalidateSharedKeys() called on tag invalidation

## LRU Handler (local-lru)

- [ ] LRUCache from lru-cache library
- [ ] Configuration: maxItemsNumber, maxItemSizeBytes
- [ ] Size calculation based on JSON.stringify length
- [ ] Implicit tag revalidation timestamp tracking
- [ ] get() checks both explicit and implicit tags
- [ ] delete() from LRU if ANY tag was revalidated after lastModified
- [ ] revalidateTag() stores timestamp for implicit tags
- [ ] revalidateTag() deletes entries with matching tag
- [ ] No external dependencies on expiration (relies on CacheHandler check)

## Composite Handler

- [ ] First-match read strategy (sequential through handlers)
- [ ] Custom setStrategy function to choose handler
- [ ] Parallel revalidateTag across all handlers
- [ ] Parallel delete across all handlers
- [ ] Minimum 2 handlers validation

## Helper Utilities

### Timeout & Abort Handling
- [ ] withAbortSignal() function for timeout support
- [ ] Event listener cleanup (removeEventListener)
- [ ] Settled flag to prevent double settlement
- [ ] withAbortSignalProxy() for wrapping Redis client

### Buffer Conversion
- [ ] parseBuffersToStrings() for APP_ROUTE (body: Buffer -> string)
- [ ] parseBuffersToStrings() for APP_PAGE (rscData, segmentData)
- [ ] convertStringsToBuffers() reverse conversions
- [ ] Base64 encoding/decoding

### Tag & Revalidation
- [ ] getTagsFromHeaders() from x-next-cache-tags header
- [ ] isImplicitTag() check with NEXT_CACHE_IMPLICIT_TAG_ID prefix
- [ ] resolveRevalidateValue() from FETCH, APP_PAGE, or PAGES kinds

### TTL Management
- [ ] createValidatedAgeEstimationFunction()
- [ ] getInitialExpireAge() with 1.5x multiplier
- [ ] Validation: positive integer ≤ MAX_INT32
- [ ] Default stale age: 1 year (31536000 seconds)

### Redis Cluster Support
- [ ] withAdapter() for RedisClusterType
- [ ] isReady property check all replicas

### Constants
- [ ] NEXT_CACHE_IMPLICIT_TAG_ID = "_N_T_"
- [ ] MAX_INT32 = 2147483647
- [ ] REVALIDATED_TAGS_KEY = "__revalidated_tags__"

## Instrumentation

- [ ] registerInitialCache() function
- [ ] Pre-warm cache on application start
- [ ] Read and populate pages (Pages Router)
- [ ] Read and populate app routes (App Router)
- [ ] Read and populate fetch cache
- [ ] Build directory handling (.next/)
- [ ] File system interaction safety
- [ ] Configurable options: fetch, pages, routes, buildDir

## Error Handling & Resilience

- [ ] Promise.allSettled() for fault tolerance in multi-handler
- [ ] Continue to next handler on failure (get method)
- [ ] Never fail entire operation on single handler failure
- [ ] Graceful degradation: Redis unavailable -> LRU only
- [ ] Error event listeners on connections
- [ ] Global state reset on critical failures
- [ ] Descriptive error messages
- [ ] No silent failures (all errors logged)

## Logging & Debugging

- [ ] Debug flag: typeof process.env.NEXT_PRIVATE_DEBUG_CACHE !== "undefined"
- [ ] Structured log format: [CacheHandler] [context] [key] message
- [ ] Debug logs in: constructor, configureCacheHandler, get, set, revalidateTag
- [ ] Warning logs for errors
- [ ] Info logs for successful operations
- [ ] No performance impact when debug disabled

## Time Handling

- [ ] lastModified in MILLISECONDS (JavaScript Date.now())
- [ ] lastModifiedAt in SECONDS (Unix timestamp)
- [ ] staleAt in SECONDS
- [ ] expireAt in SECONDS
- [ ] Expiration check: `expireAt < Math.floor(Date.now() / 1000)`
- [ ] Implicit tag timestamps in MILLISECONDS
- [ ] Implicit tag check: `timestamp > cacheValue.lastModified` (both milliseconds)

## Edge Cases

- [ ] Handler returns null/undefined -> cache miss
- [ ] No lifespan (fallback:false pages) -> cache forever
- [ ] Empty tags array -> valid, no revalidation
- [ ] Large tag maps in Redis -> HSCAN with cursor
- [ ] Already-aborted signal -> immediate rejection
- [ ] Signal aborted during operation -> rejection with error
- [ ] Multiple handler failures -> continue with remaining handlers
- [ ] setStrategy returns invalid index -> default to first handler
- [ ] Redis client not ready -> assertion error
- [ ] Timeout exceeds operation -> AbortError
- [ ] Stale entry with valid TTL -> delete in background, return null
- [ ] Missing x-next-cache-tags header -> empty array
- [ ] Development mode -> log warning about cache disabled
- [ ] Build phase special handling for fetch cache and Pages Router

## Testing Requirements

- [ ] Unit tests for all helpers (withAbortSignal, buffer conversion, etc.)
- [ ] Unit tests for TTL calculation and validation
- [ ] Integration tests for handlers with mocked clients
- [ ] Tests for error paths (timeouts, connection failures)
- [ ] Tests for race conditions (abort vs resolve)
- [ ] Tests for memory leak prevention (event listener cleanup)
- [ ] Tests for implicit tag tracking
- [ ] Tests for tag extraction from headers
- [ ] Tests for composite handler routing
- [ ] E2E tests with actual Redis (Docker)
- [ ] Tests for all edge cases listed above

## Documentation Requirements

- [ ] JSDoc for all public APIs
- [ ] Type exports in public API
- [ ] README with configuration examples
- [ ] Examples for Redis, LRU, and Composite handlers
- [ ] Example Next.js 16+ integration
- [ ] Example instrumentation.ts setup
- [ ] Architecture documentation
- [ ] Migration guide (if applicable)

## Performance & Production Readiness

- [ ] No N+1 queries for tag revalidation (HSCAN batching)
- [ ] Parallel operations where appropriate (Promise.all)
- [ ] Non-blocking background cleanup (no await for delete in background)
- [ ] Connection pooling / singleton pattern for Redis
- [ ] Configurable timeouts (default reasonable values)
- [ ] Memory leak prevention (cleanup event listeners, cursor iteration)
- [ ] No unbounded loops or array growth
- [ ] Efficient data structures (Map for tag lookups)
- [ ] Build-time cache pre-warming
- [ ] Single connection mode support for hot reload

## Code Quality

- [ ] Strict TypeScript mode
- [ ] No `any` types
- [ ] Type inference where possible
- [ ] Consistent error handling
- [ ] Descriptive variable names
- [ ] Self-documenting code
- [ ] Minimal dependencies (lru-cache, redis)
- [ ] Clean, minimal abstractions
- [ ] Composition over inheritance
- [ ] Proper use of async/await

## Package Setup

- [ ] Correct exports in package.json
- [ ] TypeScript build configuration
- [ ] ES Module + CommonJS dual build
- [ ] Type definitions (.d.ts files)
- [ ] Correct Node version requirement (22+)
- [ ] Next.js 15+ peer dependency
- [ ] Optional redis peer dependency
- [ ] Biome for formatting
- [ ] Vitest for testing
- [ ] Playwright for e2e tests
- [ ] Docker Compose for infrastructure

---

## Summary

**Total Checklist Items**: 200+

When implementing, prioritize in this order:
1. Core types and interfaces (compatibility)
2. CacheHandler orchestration
3. Redis and LRU handlers
4. Helper utilities (critical for correctness)
5. Error handling and logging
6. Instrumentation
7. Tests and documentation

