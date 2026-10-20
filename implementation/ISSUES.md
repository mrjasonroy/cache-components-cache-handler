# Known Issues

> **Version numbers.** 16.5.0 and 16.5.1 were published by mistake, ahead of Next.js, and
> withdrawn; their changes and the release these records call 16.6.0 ship together as 16.4.3. Where
> a record below names "16.5" as the version users upgrade from, read 16.4.2: its key layout,
> `createCacheHandler` storage and `RedisCacheHandler` constructor are the same. "The 16.5 stack"
> or "the 16.5 path" is the legacy `createCacheHandler` data stack and the `redis: RedisOptions`
> form. The headings of DEC-1 and DEC-2 keep the numbers those releases had.

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

## ISSUE-2: Known limits of shared tag coordination and `flushCache` (16.4.3)

**Status:** Open (by design) · **Severity:** Low · **Area:** `shared/tag-store.ts`, `shared/flush.ts`

These are documented in `docs/how-it-works.md` and `docs/operations.md`; they are listed here so they are not rediscovered as bugs.

- **Outage invalidations stay local.** A `revalidateTag` while Redis is down reaches only the
  instance that made it (a warning is logged). Other instances keep serving their copy until it
  ages out (at most 60 s for outage memory; until `revalidate` for local `"use cache"` values).
- **Clock skew over 5 s** between instances can delay an invalidation on other instances until
  the tag is updated again (`SYNC_SKEW_MS`).
- **The local handler serves through an outage of its own instance.** Its values live in memory,
  so an instance that cannot reach Redis keeps serving them, past the 60 s outage bound, until
  `revalidate` or a tag invalidation it sees (Opus final review: accepted degraded mode).
- **`flushCache` empties only the calling process's memory.** Other instances keep their local
  `"use cache"` values until `revalidate` or a tag invalidation. A cross-instance flush would need
  a broadcast (for example a reserved tag written on flush).

## ISSUE-3: Connection tuning is not public

**Status:** Resolved (DEC-4 for the 16.5 path; public on `CacheOptions` since DEC-6, approved by Jason on 2026-10-20) · **Severity:** Low · **Area:** `shared/runtime.ts`, `shared/connection.ts`

Resolution: `createCacheHandler` and `RedisCacheHandler` / `createRedisCacheHandler` (including
`redis: RedisOptions`) now take `connectTimeout`, `socketTimeout` and `maxConsecutiveTimeouts`
and pass them to the connection. DEC-6 then made them `CacheOptions`, so every factory and
`flushCache` take them; `withCache` stays environment-only.
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
taken as a reference. With several Next versions in one process, every registered storage is
consulted on every call, including one registered after the first, and `Date` is read only when
all of them are safe (`shared/clock-detection.test.ts`, Codex review 6).

Known limit (architecture review L6): without Next's storage, `isDateNative()` also says no when
any other library has replaced `Date` (`@sinonjs/fake-timers`, `timekeeper`, some APM agents). The
clock then fails closed: it never measures the offset and stays on the performance clock, which is
what Next's own handlers use. That is safe for prerenders, but that process's stored times can
drift from other instances' over a long uptime, so "instances agree on time" stops holding for it.
Documented in `docs/how-it-works.md`, under the tag coordination limits.

## ISSUE-5: `flushCache` kept a plain Node process alive

**Status:** Fixed (16.4.3) · **Severity:** Medium · **Area:** `shared/flush.ts`, `shared/runtime.ts`

Found in a site's Jest suite: `flushCache()` opened the package's shared Redis client, nothing
closed it, and the process never exited. Once teardown removed the Redis container, ioredis
retried `ECONNREFUSED` until the CI job timed out (18 minutes). Any script or CLI calling
`flushCache` hung the same way.

Reproduction: `src/shared/flush-exit.test.ts` runs `flushCache({ url })` from the compiled package
in a child Node process, with Redis unreachable (a closed port) and reachable
(`CACHE_TEST_REDIS_URL`), and requires the process to exit by itself within 8 s. Before the fix
both were killed at the timeout.

Fix: `flushCache` uses the shared connection only when a handler has already opened it (or the
application passed its own `client`); otherwise `acquireCacheRuntime` gives it a runtime on an
unshared connection that it closes in a `finally`. Because that connection's tag store is dropped
with it, a flush record Redis did not take is an error there rather than a retry
(`src/shared/flush-connection.test.ts`).

Not done: `unref()` on the package's own clients. ioredis has no `unref` option, and unreffing its
socket would let a script exit while a command it awaits is still in flight (an awaited promise
does not keep Node alive), silently dropping a flush or a revalidation write. In a Next server the
HTTP server keeps the process alive anyway, so it would change nothing there. A test that creates
handlers still holds their shared client, as any handler-owned connection does: it calls
`closeCache()` at the end (added in 16.4.3 with Jason's approval, DEC-6), which closes it. Its exit is
tested the same way, in the same child processes (`src/shared/flush-exit.test.ts`).

## ISSUE-6: Review findings deferred or declined for 16.4.3

**Status:** Open (deliberate) · **Severity:** Low · **Area:** several

Each was raised in a review of PR #78 and left as it is on purpose. They are listed here so none
is dropped silently.

- **A revalidation with durations expires entries rendered after it** (Codex review 4, M2).
  Declined: it is what Next's own `areTagsExpired` does; the package is stricter only for
  immediate revalidations. Semantics in DEC-3.
- **A rolling deploy from 16.4.2 splits tag invalidation** (Opus final review, M1; raised against
  16.5.x, whose tag keys are the same as 16.4.2's). No tag-key shim: 16.4.3 neither reads nor
  writes the old tag keys, so a revalidation on a 16.4.2 instance does not reach 16.4.3 instances
  while both serve. `docs/migrating.md` and the CHANGELOG give the deploy step instead (recreate,
  or revalidate once from 16.4.3). A shim would keep the old key layout alive in 16.x.
- **`createCacheHandler` does not reconnect after `closeCache()`** (DEC-6). Declined: making the
  16.5 stack re-resolve its connection was not worth it for a deprecated API. Its deprecation note
  says to create it again.
- **The 16.5 data stack is deprecated, not removed or shimmed** (architecture review M3, phase 2).
  Deferred to the Next 17 line (DEC-6): it keeps working through 16.x, and removing it, or
  rebuilding `createCacheHandler` over `createRemoteCacheHandler`, is a breaking change.
- **No `globalSlot()` helper for the global state** (architecture review L5). DEC-5 writes down the
  rule, which was the finding's cost (M2 broke an unwritten rule). Folding the global slots into
  one helper is a refactor with no change in behaviour, left for after the release.
- **No `buildOutput: false` opt-out** (Opus review 3, #4). Build output's `lastModified` is the
  build time from `cache-handler-build.json`, not the file mtime (DEC-3), which was the problem;
  nobody has asked to turn build output off.
- **A slow transfer of a 1 to 5 MB entry can count as a timeout** (Opus review 3, #6). Three in a
  row drop the connection for the process. Documented (`docs/custom-handlers.md`: about 40 Mbit/s at
  the default 1 s `commandTimeout`); compression makes such entries 5 to 15 times smaller (DEC-4).
  No size-proportional timeout: it would let one slow server stall every cached call longer.
- **A tag state Redis has not acknowledged stays in the process after `closeCache()`** (DEC-6).
  Accepted: pending invalidations are never dropped to impose a limit. Bounded by distinct
  option sets times key prefixes; an application client's goes with the client.
- **The shared connection and tag state log through the first handler's `logger`** (DEC-7).
  Accepted: keying them by logger would split the shared client (DEC-3, DEC-6). Use one logger, or
  `setCacheLogger`.
- **`RedisCacheHandlerOptions.redis` is not marked `@deprecated`** (architecture review L7).
  Declined: `RedisCacheHandler` is not deprecated, and `redis` is how an existing 16.5 setup
  passes host, port and TLS. Marking it would show strike-through warnings to users who need
  not change anything. It stays documented as the 16.5 form, beside `url`/`client`.
- **No `CACHE_DEBUG` line when the clock offset was never measured** (architecture review L6).
  DEC-3, ISSUE-4 and `docs/how-it-works.md` describe the fail-closed case; the debug line is not added.

## ISSUE-7: Credentials in logged errors, a Cluster flush that could hang, corrupt blob references

**Status:** Resolved (16.4.3, final review M1, M2, L1, L2) · **Severity:** Medium · **Area:** `shared/logger.ts`, `shared/connection.ts`, `shared/flush.ts`, `shared/codec.ts`, `handlers/redis.ts`

- **M1, credentials in logged errors.** ioredis 5.8 attaches `command: { name, args }` to a reply
  error (`DataHandler.returnError`), so a rejected `AUTH` reached the logger and the console with
  the password it tried. `writeLog` now passes every message, meta and console argument through
  `redactForLog`: errors (and error-like objects) become a new `Error` with only name, message,
  stack, `code`, `errno`, `syscall`, `address`, `port` and a cause redacted the same way; plain
  objects lose `command`, `password`, `options` and similar keys; any other object (a `Buffer`, a
  typed array, a class instance) becomes a placeholder, never kept by identity; URLs lose their user
  information through the last `@` of the authority (`redis://u:pre@fix@host`). Free text that
  spells a credential out some other way is not scrubbed; the guarantee is structured fields,
  causes and URL user information. Reproduce: emit that error shape on the client
  (`logger.test.ts`, "a rejected AUTH"); a class-instance or `Buffer` cause and a multi-`@` URL
  ("causes that are not plain objects").
- **M2, a Cluster flush could hang.** `flushCache` scans `nodes("master")`, whose clients and
  pipelines were outside the `commandTimeout` proxy over an application client. The proxy now
  bounds what `nodes()` returns and a pipeline's `exec`; a flush that fails part-way throws, saying
  some keys may already be deleted. Reproduce: a master whose SCAN or pipeline never answers
  (`flush.test.ts`).
- **L1, a page handler's `logger` reached only its debug lines.** `toRuntimeOptions` now forwards it,
  so the runtime it opens logs connection and tag errors there too.
- **L2, corrupt blob references.** A `__nch_b` reference must be two safe non-negative integers
  inside the blob section, and a marker object must be the marker alone; anything else is a miss.
  Before, `[-1, 1]` decoded into a byte of the header. Only an array under `__nch_b` / `__nch_m` is
  a marker, as the encoder writes it: an ordinary object with that key and any other value (a
  header named `__nch_b`) is plain JSON and round-trips (final gate 2, L2).

## ISSUE-8: A crash between a tag hash write and a failed index write can leave an orphan field

**Status:** Open (accepted limitation) · **Severity:** Low · **Area:** `shared/tag-store.ts`

The hash update and `ZADD GT` run as separate single-key commands for Cluster compatibility.
If HSET succeeds, ZADD fails, and the process dies before replaying its queued invalidation,
the hash may contain a field absent from the index. On Redis 7.4+ and Valkey 9+ its field TTL
still bounds retention. The standalone fallback walks the index, so on older servers that
orphan field stays until a full flush or a later revalidation. Reproduce by rejecting ZADD
after an acknowledged hash write, then terminating the writer before its next sync/reconnect.
An extra hash scan could recover these fields, but is not part of this release's bounded prune.
