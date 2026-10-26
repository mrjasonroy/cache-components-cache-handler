# Upgrading from 16.4.2: public surface inventory

16.4.3 reaches every `^16.4.2` / `~16.4.2` install automatically (the version follows Next.js). Policy
(DEC-14): a 16.4.2 setup keeps working on upgrade; every 16.4.2-only API is deprecated in 16.4.3
(JSDoc `@deprecated` plus a one-time warning per process on first use) and removed in **16.5.0**.

Sources: `git show v16.4.2:packages/cache-handler/src/index.ts`, the 16.4.2 README (root and
package), `docs/installation.md`, `docs/redis.md`, `docs/api-reference.md`, the 16.4.2 example app
(`apps/e2e-test-app/*.mjs`) and the JSDoc on `RedisCacheHandler`. RC-only APIs (`useCache`,
`MEMORY_ONLY_TAG`, `createRedisCacheHandler`) were never in 16.4.2 and are not listed.

Status: **unchanged**, **changed** (same call, different observable behaviour), **deprecated**
(works, warns once, removed in 16.5.0), **removed** (none).

## Exports and options

| 16.4.2 API | 16.4.3 status | Removed in 16.5.0? | Covered by |
|---|---|---|---|
| `createCacheHandler({ type: "memory" \| "redis" \| "valkey" \| "elasticache", url, endpoint, port, tls, password, keyPrefix, tagPrefix, debug, maxSize })` | deprecated; changed (see behaviour) | yes | U, I, E |
| `createRedisDataCacheHandler({ redis, keyPrefix, tagPrefix, defaultTTL, debug })` | deprecated; changed (serves to `expire`, logs errors) | yes | U, I |
| `createIoredisAdapter(client)` | deprecated | yes | U, I |
| `createMemoryDataCacheHandler({ maxSize, debug })` | deprecated | yes | U |
| `createCacheConfig({ isrHandlerPath, dataCacheHandlerPath, disableDefaultMemoryCache })` | deprecated; output and return type identical when called the 16.4.2 way (`isrHandlerPath` now optional; without it `cacheHandler` is `string \| undefined`) | yes | U, T |
| `createCacheConfigWithProfiles(...)` | deprecated; same as above | yes | U, T |
| `RedisCacheHandler` (class, subclassed as Next's `cacheHandler`) | **kept** (it is the 16.4.3 page handler); internals rewritten | no | U, I, E |
| — option `redis: Redis \| string \| RedisOptions` | deprecated (use `client` / `url`) | yes | U, I, E |
| — option `keyPrefix` | unchanged meaning; keys now `<keyPrefix><buildId>:page:<key>` | no | I, E |
| — option `tagPrefix` | deprecated, ignored | yes | U |
| — option `defaultTTL` | changed: default 365 days (16.4.2: no expiry). Any non-number boots: a numeric string is converted, every other non-number (falsy, `"1h"`, `"abc"`, objects) is dropped, each with a warning naming the value. Negative and infinite numbers throw (never cached in 16.4.2). See the measured table below | the non-number forms yes | U |
| — option `debug` | unchanged | no | — |
| — no `redis` option | **changed**: reads `REDIS_URL` / `VALKEY_URL` / `ELASTICACHE_*`; with none it runs in memory (16.4.2 connected to `localhost:6379`) and a production server logs a one-time warning saying so (never for withCache's built-in handler) | — | U |
| — `get(key, { implicitTags })`, `set(key, value, { revalidate, tags })` | unchanged call shapes; `get` no longer returns `age` | — | U, I |
| — `revalidateTag(tag)` | unchanged; also takes `string[]` and durations | no | U, I |
| — `delete(key)` | unchanged | no | — |
| — `close()` | deprecated (`closeCache()`); now closes every package connection and empties memory stores | yes | U |
| `MemoryCacheHandler`, `createMemoryCacheHandler` | deprecated | yes | U |
| `CompositeHandler`, `createCompositeHandler` | deprecated | yes | U |
| `bufferToString`, `stringToBuffer`, `isImplicitTag`, `jsonReplacer`, `jsonReviver`, `calculateLifespan`, `isExpired` | deprecated, unchanged behaviour | yes | U |
| `IMPLICIT_TAG_PREFIX` | deprecated (JSDoc only), unchanged value | yes | U |
| Types: `CacheHandler`, `CacheHandlerContext`, `CacheHandlerGetMeta`, `CacheHandlerOptions`, `CacheHandlerValue`, `CacheValue`, `LifespanParameters`, `CompositeHandlerOptions`, `MemoryCacheHandlerOptions`, `CacheHandlerConfig`, `DataCacheHandlerOptions`, `CacheHandlerType`, `MemoryDataCacheHandlerOptions`, `RedisDataCacheHandlerOptions`, `RedisClient`, `IoredisLike` | deprecated (JSDoc) | yes | T |
| Types: `RedisCacheHandlerOptions` | deprecated alias of `PageCacheHandlerOptions` (JSDoc only); 16.4.2 fields still accepted | yes | T |
| Types: `DataCacheEntry`, `DataCacheHandler`, `Timestamp` | unchanged (Next's own contract, used by the 16.4.3 handlers) | no | T |

U = `src/upgrade-16.4.2.test.ts`, T = `src/upgrade-16.4.2.test-d.ts`, I =
`src/integration/upgrade-16.4.2.redis.test.ts` (real Redis), E = CI e2e lane `redis-16.4.2-config`,
which runs one 16.4.2 setup: the README quick-start data handler (`createCacheHandler({ type:
"redis" })` for `cacheHandlers.default` and `remote`) with the `RedisCacheHandler` subclass from
its JSDoc ("Option 1": `redis: process.env.REDIS_URL`, `keyPrefix: "nextjs:cache:"`,
`defaultTTL: 3600`) as `cacheHandler`, `cacheMaxMemorySize: 0`, no `withCache`
(`apps/e2e-test-app/upgrade-16.4.2/`). The `MemoryCacheHandler`-subclass setup from the 16.4.2
example app is covered by U only.

### `RedisCacheHandler` `defaultTTL` in 16.4.2, measured

v16.4.2's `handlers/redis.ts` run under Node against a fake ioredis client that records the write
command and rejects a non-integer or non-positive `SETEX` TTL (as Redis does). The entry is a
`FETCH` set with no `revalidate`, the only path where `defaultTTL` applies.

| `defaultTTL` | 16.4.2 command | 16.4.2 cached? | 16.4.3 |
|---|---|---|---|
| `0`, `NaN`, `null`, `""`, `false` | `SET` (no TTL) | yes, forever | dropped, warning, 365 days |
| `"1h"`, `"abc"`, `"-5"`, `{}` | `SET` (no TTL) | yes, forever | dropped, warning, 365 days |
| `"1e3"` | `SETEX` with a huge TTL | yes | converted (1000 s), warning |
| `"60"`, `"0"`, `" "`, `true` | none (TTL computed negative) | no | `"60"` converted (60 s); others dropped; warning |
| `-1`, `-5`, `-Infinity` | none | no | throws |
| `Infinity` | `SETEX Infinity`, rejected | no | throws |
| `0.5`, `120` (any positive number) | none | **no** | works (rounded up to whole seconds) |

The last row is a 16.4.2 bug: `calculateLifespan` returns seconds and `set` subtracted
`Date.now()` (milliseconds), so the TTL was always negative and the write skipped. The same bug
meant 16.4.2's `RedisCacheHandler` never stored an entry with a numeric `revalidate` either (only
`revalidate: false` or none, with no numeric `defaultTTL`). 16.4.3 caches them: a 16.4.2 user
whose pages were never cached will see them cached after the upgrade.

## Documented setups

| 16.4.2 setup | 16.4.3 | Covered by |
|---|---|---|
| README quick start: `data-cache-handler.mjs` = `createCacheHandler({ type: "redis" })`, `cacheHandlers.default/remote` → it, `cacheMaxMemorySize: 0`, optional `cacheHandler` | works, warns once | E, I |
| `cacheHandler` = `RedisCacheHandler` subclass (`super({ ...options, redis: REDIS_URL, keyPrefix, defaultTTL })`) | works; pages shared through Redis; warns once (`redis` option) | E, I |
| `cacheHandler` = `MemoryCacheHandler` subclass (16.4.2 example app: `maxItemsNumber: 100, defaultTTL: 3600`) | works, warns once; not in the e2e lane | U |
| Bring your own ioredis: `createRedisDataCacheHandler({ redis: createIoredisAdapter(new Redis(url)) })` | works, warns once per API | I |
| node-redis client passed straight to `createRedisDataCacheHandler` | works (unchanged `RedisClient` contract) | type only |
| `createCacheConfig` spread into `next.config` | works, same output | U |
| ElastiCache via `createCacheHandler({ type: "elasticache" })` + `ELASTICACHE_*` | works | existing `factory.test.ts`, CI `e2e-elasticache` (via withCache) |

## Environment variables

| 16.4.2 variable | 16.4.3 |
|---|---|
| `REDIS_URL`, `VALKEY_URL`, `REDIS_PASSWORD` | unchanged (I) |
| `ELASTICACHE_ENDPOINT`, `ELASTICACHE_PORT`, `ELASTICACHE_TLS`, `ELASTICACHE_AUTH_TOKEN` | unchanged; `ELASTICACHE_AUTH_TOKEN` is ignored when `ELASTICACHE_IAM_USER` (new) is set |
| new, may change a 16.4.2 app that happens to set them | `CACHE_REDIS=off`, `CACHE_KEY_PREFIX`, `CACHE_DEBUG`, `CACHE_COMPRESSION`, `CACHE_MEMORY_HEAP_PERCENT`, `CACHE_MEMORY_MAX_MIB`, `ELASTICACHE_IAM_USER`, `ELASTICACHE_CACHE_NAME`, `ELASTICACHE_REGION`, `ELASTICACHE_SERVERLESS` |

## Entries 16.4.2 left in Redis (verified, I)

- `createCacheHandler` / `createRedisDataCacheHandler` keep 16.4.2's layout (`<keyPrefix><cacheKey>`
  JSON, `<tagPrefix><tag>` hash), so a 16.4.2 entry under the same key is **read as a hit** and a
  16.4.2 tag record still invalidates it. Keys only collide when the build ID is the same across
  builds (Next puts it in the cache key); otherwise the cache starts cold.
- The page handler and `withCache`'s handlers use `<prefix><buildId>:page|data:<key>` in the binary
  v2 format. A 16.4.2 value at one of those keys is a **miss, never an error**, and is replaced by
  the next render. 16.4.2's own page keys (`nextjs:cache:<key>`) are never read.
- 16.4.2 tag keys (`<prefix>tags:<tag>` strings, `<prefix>tags:<tag>:keys` sets) do not interfere
  with 16.4.3 revalidations and are left untouched (no TTL on the strings: they stay until deleted).

## Behaviour a 16.4.2 user will observe on upgrade (release notes)

- **Deprecation warnings**: one line per deprecated API the application calls, once per process
  (a factory does not add a line for the class it builds), e.g.
  `@mrjasonroy/cache-components-cache-handler: createCacheHandler is deprecated and will be removed in 16.5.0. … See …/docs/migrating.md`.
  Routed through `setCacheLogger` when set, else `console.warn`.
- **ISR warning**: `createCacheHandler` (Redis types) in production logs once that it only covers
  `"use cache"`, unless a `RedisCacheHandler` exists in the process or `suppressIsrWarning: true`.
- **Error logs**: Redis failures in the data stack used to be swallowed (debug only); they are now
  logged, rate-limited. New `[RedisCache]:` warnings: connection down/up, a second connection with
  different settings, tag maintenance, the memory budget above 50% of the heap.
- **Cold cache** for the page handler: keys are new and scoped by build/deployment ID, so every
  deploy starts cold for pages. Old `nextjs:cache:*` keys expire on their own (or never, for
  16.4.2 entries written without TTL; `nextjs:tags:<tag>` strings never expire).
- **Entry format**: the page handler writes binary v2 (Brotli-compressed v3 at 16 KB and over;
  `CACHE_COMPRESSION=off` disables). The legacy data stack still writes 16.4.2's JSON.
- **Revalidations do not cross a rolling deploy** from 16.4.2 for the page handler (docs/migrating.md).
- **Connection**: one shared ioredis connection per server; no offline queue; 1000 ms command
  timeout (16.4.2: none); reconnects forever with backoff (16.4.2 ElastiCache gave up after 3
  retries); during an outage entries go to a bounded in-process fallback for up to 60 s.
- **`next build` no longer connects to Redis** (nor with `CACHE_REDIS=off`, nor on the edge
  runtime): build-time entries stay in the build process. 16.4.2 connected and wrote them to Redis.
- **Data stack timing**: entries are served until `expire` (stale after `revalidate`, regenerated in
  the background) instead of being dropped at `revalidate`; Redis TTL is the remaining time to
  `expire`, capped at 366 days; tag hashes get a TTL.
- **Page handler lifetimes**: `1.5 × revalidate` capped at `expire`; 365 days without a period
  (16.4.2: no TTL). Revalidation is timestamp-based (16.4.2 deleted the tagged keys).
- **Memory**: in-process stores (fallback, tag state, `"use cache"` memory) share a budget of 10% of
  the V8 heap by default (`CACHE_MEMORY_HEAP_PERCENT` / `CACHE_MEMORY_MAX_MIB`).
- **Lockfiles**: new optional peer dependencies `@aws-crypto/sha256-js`,
  `@aws-sdk/credential-provider-node`, `@smithy/signature-v4` (only for ElastiCache IAM; not
  installed unless the app adds them). `ioredis` stays an optional dependency.
- **Node.js (upgrade note)**: `engines.node` moves from `>=22.0.0` to `>=22.3.0`, by decision.
  The package needs `process.getBuiltinModule`: on Node 22.0–22.2 the first cache call throws
  `Cannot load node:…: this package needs Node.js 22.3 or later`, and Yarn 1 refuses to install on
  the engines mismatch. Users on 22.0–22.2 must upgrade Node (docs/migrating.md says so first).
- **No-connection warning**: a `RedisCacheHandler` subclass with no connection setting logs once in
  production that it is running in memory where 16.4.2 connected to `localhost:6379`.
- **Types**: `CacheHandlerConfig.cacheHandler` is optional. Code that annotates
  `const c: CacheHandlerConfig = createCacheConfig(...)` and then uses `c.cacheHandler` as a
  `string` no longer type-checks (drop the annotation, or use `c.cacheHandler!`). `createCacheConfig` /
  `createCacheConfigWithProfiles` still return `cacheHandler: string` when given `isrHandlerPath`.
  `RedisCacheHandler.get` no longer returns `age`.
