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
 * Nothing here starts with `<prefix>tags:`: 16.5's `RedisCacheHandler` and `createCacheHandler`
 * write `nextjs:tags:<tag>` keys of other types, and a tag named `index` must not collide.
 *
 * Tag records sit above the build ID, so a `revalidateTag` during a rolling deploy reaches the
 * old build's entries and the new build's.
 */

/**
 * Lifetime of tag records and of the tag index, in seconds: 366 days. `cacheLife("max")`
 * has the longest built-in `expire` (365 days) and entry TTLs are capped at this value, so a
 * record always outlives the entries it can invalidate; the extra day absorbs clock skew.
 */
export const TAG_TTL_SECONDS = 366 * 24 * 60 * 60;

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
