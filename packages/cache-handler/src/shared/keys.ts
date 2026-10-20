/**
 * Redis key layout (documented for operators in the package README):
 *
 * ```
 * <prefix><buildId>:page:<key>   page / route / fetch entry (singular cacheHandler)
 * <prefix><buildId>:data:<key>   "use cache: remote" entry
 * <prefix>tags                  hash of every tag record: field = tag, value = "<stale>,<expired>" (ms)
 * <prefix>tag-index             sorted set of the same tags, scored by last update time (ms)
 * ```
 *
 * The two tag keys have no TTL and are never pruned: a tag record must outlive every entry it can
 * invalidate. Run Redis with `noeviction` or a `volatile-*` policy (entries have TTLs, tag keys do
 * not); under an `allkeys-*` policy an evicted tag hash brings every invalidated entry back.
 *
 * Nothing here starts with `<prefix>tags:`: 16.4.2's `RedisCacheHandler` and `createCacheHandler`
 * write `nextjs:tags:<tag>` keys of other types, and a tag named `index` must not collide.
 *
 * Tag records sit above the build ID, so a `revalidateTag` during a rolling deploy reaches the
 * old build's entries and the new build's.
 */

/**
 * Longest any cached value is kept or served, in seconds: 365 days, `cacheLife("max")`'s
 * `expire`. Every store caps an entry's age at this on write and on read, whatever its profile
 * or `defaultTTL` says. Tag records are never deleted, so this is not what keeps an invalidated
 * value from coming back; it bounds memory and keeps an entry from living forever.
 */
export const MAX_ENTRY_AGE_SECONDS = 365 * 24 * 60 * 60;

/**
 * Key of a page, route or fetch entry.
 */
export function pageKey(prefix: string, buildId: string, key: string): string {
  return `${prefix}${buildId}:page:${key}`;
}

/**
 * Key of a `"use cache: remote"` entry.
 */
export function dataKey(prefix: string, buildId: string, key: string): string {
  return `${prefix}${buildId}:data:${key}`;
}

/**
 * Key of the hash holding every tag record.
 */
export function tagsKey(prefix: string): string {
  return `${prefix}tags`;
}

/**
 * Key of the sorted set of tags by last update time.
 */
export function tagIndexKey(prefix: string): string {
  return `${prefix}tag-index`;
}

/**
 * Tag record `flushCache({ scope: "all" })` writes, through the normal tag update, after the
 * flush: the build output is checked against it, so a flush that deleted the tag records cannot
 * bring back a prerendered page revalidated before it. Entries rendered after the flush are newer
 * than it and unaffected.
 */
export const FLUSH_TAG = "__cch_flush__";

/**
 * Tag record `flushCache({ scope: "build" })` writes for that build (see {@link FLUSH_TAG}).
 */
export function buildFlushTag(buildId: string): string {
  return `${FLUSH_TAG}:${buildId}`;
}
