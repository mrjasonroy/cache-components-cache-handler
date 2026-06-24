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
