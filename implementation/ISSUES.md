# Known Issues

## ISSUE-1: `revalidateTag(tag, "max")` permanently blocks re-caching for that tag

**Status:** ✅ Resolved · **Severity:** High · **Area:** `data-cache/redis.ts` (tag invalidation)

**Fix:** `updateTags` now records the revalidation **event time** (`now`) in the
tag's `stale` field and uses `expired` only as the hard-deletion deadline.
`get()` treats an entry as affected only when it was created *before* the event
(`revalidatedAt > entry.timestamp`), so entries cached *after* a revalidation are
served normally; affected entries are served stale (`revalidate = -1`) until the
deadline, then deleted. `getExpiration` returns the event time per the Next.js
contract. Covered by tests in `data-cache/redis.test.ts`
(`re-caches a tag after revalidateTag with a future expire`,
`getExpiration returns the latest revalidation event timestamp`).

### Summary

After `revalidateTag(tag, "max")` (or any `revalidateTag(tag, <duration>)` with a
future expire), content for that tag can no longer be cached — every subsequent
`get()` for an entry carrying that tag returns `undefined`, so the page
re-renders fresh on every request until the (potentially far-future) expiry
passes.

Because Next.js now deprecates the single-argument form and instructs callers to
pass `"max"` (`"revalidateTag" without the second argument is now deprecated, add
second argument of "max" or use "updateTag"`), this affects normal usage.

### Reproduction (handler level, deterministic)

```js
const handler = createRedisDataCacheHandler({ redis: createIoredisAdapter(ioredis), defaultTTL: 86400 });

// 1. cache + serve an entry tagged "T"  -> served ✅
// 2. handler.updateTags(["T"], { expire: 31536000 })   // what revalidateTag(tag,"max") triggers
// 3. cache a NEW entry tagged "T", then get() it       -> returns null ❌ (expected: served)

// Control: handler.updateTags(["T"]) (immediate expiry) does NOT block re-caching ✅
```

Observed at the e2e level too: once `E2E-201` revalidated the shared `test-tag`
with `"max"`, the tag could not be re-cached, which is why the revalidation specs
now use per-test isolated tags.

### Root cause

`updateTags(tags, durations)` stores a **future** deadline:

```ts
const expired = now + durations.expire * 1000; // far future for "max"
await redis.hSet(key, "expired", expired.toString());
```

…but `get()` treats `expired` as the moment of invalidation and deletes any
entry created before it:

```ts
if (expired > entry.timestamp) {   // far-future > any fresh entry.timestamp -> always true
  await redis.del(key);
  return undefined;
}
```

A freshly written entry always has `timestamp < expired`, so it is deleted on the
next read. The `expired` field conflates two concepts: *when the tag was
invalidated* (≈ `now`, which `stale` already records) versus *the future
expiration deadline* (used by `getExpiration`).

### Proposed direction (needs validation against the Next.js DataCacheHandler contract)

- Gate the hard-delete on the **invalidation time**, not the future deadline —
  e.g. record an `invalidatedAt = now` and delete entries with
  `entry.timestamp < invalidatedAt`, keeping `expired`/`getExpiration` for the
  expiration deadline only.
- Add e2e + handler tests covering: revalidate a tag with `"max"`, then confirm
  the tag re-caches on the next render.

A skipped test documenting the expected behavior lives in
`packages/cache-handler/src/data-cache/redis.test.ts`
(`re-caches a tag after revalidateTag with a future expire`).

## ISSUE-2: Known limits of shared tag coordination and `flushCache` (16.6.0)

**Status:** Open (by design) · **Severity:** Low · **Area:** `shared/tag-store.ts`, `shared/flush.ts`

These are documented in the README; they are listed here so they are not rediscovered as bugs.

- **Outage invalidations stay local.** A `revalidateTag` while Redis is down reaches only the
  instance that made it (a warning is logged). Other instances keep serving their copy until it
  ages out (at most 60 s for outage memory; until `revalidate` for local `"use cache"` values).
- **Clock skew over 5 s** between instances can delay an invalidation on other instances until
  the tag is updated again (`SYNC_SKEW_MS`).
- **`flushCache` empties only the calling process's memory.** Other instances keep their local
  `"use cache"` values until `revalidate` or a tag invalidation. A cross-instance flush would need
  a broadcast (for example a reserved tag written on flush).

## ISSUE-3: Connection tuning is not public

**Status:** Resolved for the 16.5 path (PM default, pending Jason; DEC-4) · **Severity:** Low · **Area:** `shared/runtime.ts`, `shared/connection.ts`

Resolution: `createCacheHandler` and `RedisCacheHandler` / `createRedisCacheHandler` (including
`redis: RedisOptions`) now take `connectTimeout`, `socketTimeout` and `maxConsecutiveTimeouts`
and pass them to the connection. `withCache` and `CacheOptions` stay as they were (env only).
The original report:

`connectTimeout`, `socketTimeout` and `maxConsecutiveTimeouts` exist on the internal
`RedisConnectionOptions` (defaults 2000 ms, 2000 ms, 3) but not on `CacheOptions`, so an
application cannot change them (the 16.5 `redis: RedisOptions` object reaches only ioredis's own
`connectTimeout`/`socketTimeout`). Adding them to `CacheOptions` and forwarding them in
`resolveConnection` is a possible public API addition, pending approval; nobody has asked for it.

## ISSUE-4: A route handler with sequential `"use cache"` calls is built as dynamic

**Status:** Resolved (DEC-3, `shared/clock.ts`) · **Severity:** Medium · **Area:** every handler

Next's deploy suite `test/e2e/app-dir/cache-components` (`/routes/use_cache-cached`, which awaits
two cached calls in turn) showed the route as `ƒ` with this package's handlers and as static with
Next's own. The build log printed no error: with `NEXT_PRIVATE_DEBUG_CACHE` it showed the first
call generated and set through the handler, and then neither the second call nor a final render.

Cause: with cacheComponents, Next extends `Date` so that reading the current time during a
prerender aborts it (`next/dist/server/node-environment-extensions/date.js`, `io-utils.js`). Next
calls the handlers' `get` and `set` inside the prerender's async context, and they read
`Date.now()` (for example `local.ts` before storing a value). The aborted prospective render
rejects the second call, so Next throws a `DynamicServerError`, which the build swallows. The
debug print of the prospective render's error (`printDebugThrownValueForProspectiveRender`) is
skipped for an aborted render, which is why nothing was printed.

Reproduction (unit, `src/data-cache/prerender-clock.test.ts`): load Next's
`node-environment-baseline` and `node-environment-extensions/date`, run a handler's calls inside
`workUnitAsyncStorage.run({ type: "prerender", controller, ... })`, and check
`controller.signal.aborted`. Before the fix the local, remote and Redis data cache handlers, the
page handler (with and without build output) and the ISR memory and composite handlers all
aborted it; only `createMemoryDataCacheHandler` (already on the performance clock) did not.

Fix: every handler path reads `nowMs()`, wall time measured on the performance clock and
re-anchored to `Date` only where reading it cannot abort a prerender, and converts Next's own
timestamps at the boundary (DEC-3); `shared/clock.test.ts` keeps `Date` reads out of the source.
When Next's work unit storage cannot be found (`require` fails in a packaged deploy), `Date` is
read only if Next has not extended it (`shared/clock-detection.test.ts`), and the clock never
loads Next's storage module itself, which before Next's environment would leave Next a storage
whose `run` throws (`shared/clock-before-next.test.ts`). The static guard also catches `Date.now`
taken as a reference.
