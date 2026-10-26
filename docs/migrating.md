# Migrating

## From 16.4.2 (handler files in `next.config`)

```diff
- export default {
-   cacheComponents: true,
-   cacheHandler: "./cache-handler.mjs", // if you used the package's page handler
-   cacheHandlers: {
-     default: "./data-cache-handler.mjs",
-     remote: "./data-cache-handler.mjs",
-   },
-   cacheMaxMemorySize: 0,
- };
+ import { withCache } from "@mrjasonroy/cache-components-cache-handler";
+ export default withCache({ cacheComponents: true });
```

The same goes for a config built with `createCacheConfig`. Then delete `data-cache-handler.mjs`
(and `cache-handler.mjs`). Two things change:

- `"use cache"` now goes to each instance's memory (tag invalidation is still shared through
  Redis) and `"use cache: remote"` to Redis, as Next's directives intend. If you relied on plain
  `"use cache"` being shared through Redis, change those functions to `"use cache: remote"`.
- Pages and route handlers now go through Redis too. Pass `{ pages: false }` to opt out.

The cache starts cold, because the key layout is new. Every deploy starts cold anyway, because
entries are scoped by build ID, so there is no data to migrate.

### Revalidations do not cross the upgrade

16.4.2 records a revalidation in `nextjs:tags:<tag>` keys; 16.4.3 reads and writes only the
`<prefix>tags` hash. While 16.4.2 and 16.4.3 instances serve side by side, a `revalidateTag` or
`revalidatePath` handled by a 16.4.2 instance never reaches the 16.4.3 instances, so a page they
cached can stay stale until its tag is revalidated again or the entry expires (up to a year for
`revalidate: false` or the `"max"` profile). The reverse holds too. For this one upgrade, either:

- deploy with recreate rather than rolling, so no 16.4.2 instance serves alongside 16.4.3; or
- once the last 16.4.2 instance is gone, revalidate once from a 16.4.3 instance:
  `revalidatePath("/", "layout")`, or the tags that changed during the rollout. That goes through
  the shared tag store, so it reaches every instance, including each one's `"use cache"` memory.
  `flushCache()` is not a substitute: it deletes the Redis keys in its scope and empties the
  calling process's memory, but other instances' `"use cache"` memory is not cleared.

`createCacheHandler` keeps its 16.4.2 key layout, so its own revalidations are unaffected. Between
16.4.3 builds, a revalidation reaches every instance, old build and new.

If you keep `createCacheHandler` for now, it keeps working. It now uses the shared connection and
the memory fallback, fails a command after `commandTimeout` (1000 ms; 16.4.2 had no timeout),
reconnects after an outage instead of giving up, and serves an entry until its `expire` rather
than dropping it at `revalidate`. Its options are in the
[API reference](./api-reference.md#createcachehandleroptions).

## From a 16.4.2 `RedisCacheHandler` subclass

Your code keeps working: the class name and constructor are the same, and the internals now
implement the Next 16 contract. Revalidations made by 16.4.2 instances do not reach 16.4.3 ones
during the rollout ([above](#revalidations-do-not-cross-the-upgrade) has what to do). You can
delete the subclass and use `withCache`. If you keep it:

- With no `redis` option, the handler reads `REDIS_URL`. If that is unset it runs in memory; in
  16.4.2 it connected to `localhost:6379`.
- `tagPrefix` is ignored. Tag records live in the `<keyPrefix>tags` hash.
- `get` no longer returns `age`. Next computes staleness from `lastModified` and `cacheControl`.

Old keys (`nextjs:cache:*`, `nextjs:tags:*`) are no longer read and expire on their own.

## From `@fortedigital/nextjs-cache-handler` or `@neshca/cache-handler`

```diff
- cacheHandler: require.resolve("./cache-handler.mjs"),   // CacheHandler.onCreation(...)
- cacheMaxMemorySize: 0,
+ export default withCache({ cacheComponents: true });
```

Delete `cache-handler.mjs`. `REDIS_URL` is read directly. neshca's `instrumentation.ts`
`registerInitialCache` pre-population isn't needed: a miss on a prerendered page renders it once
and stores it.

## Deprecated exports

The exports the old setups used still work in 16.x. The
[API reference](./api-reference.md#deprecated) lists each one and its replacement.
