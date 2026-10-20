/**
 * Read an entry from Redis together with the records of the tags that apply to it, so a
 * revalidation on any instance is seen by the very next read, whether or not this process's tag
 * sync has run or succeeded. Used by the page and remote handlers.
 */

import type { CacheRuntime } from "./runtime.js";

/**
 * Read the entry under `redisKey` (unless `inMemory` holds it) and the tag records that apply,
 * merging them into the tag store:
 *
 * 1. The entry and the records of `requestTags` plus the entry's tags as last seen by this
 *    process, all sent at once (one round trip).
 * 2. Only when the entry has tags that were not read: their records (a second round trip, the
 *    first time a process reads that entry).
 *
 * `read` returns the decoded entry, or `undefined` for a miss. Throws on a Redis error, entry or
 * tags: the caller treats that as a miss.
 */
export async function readWithTags<T extends { tags: string[] }>(
  runtime: CacheRuntime,
  redisKey: string,
  inMemory: T | undefined,
  requestTags: string[],
  read: () => Promise<T | undefined>,
): Promise<T | undefined> {
  const { stores, tags } = runtime;
  const known = inMemory?.tags ?? stores.entryTags.get(redisKey) ?? [];
  const fetched = new Set([...requestTags, ...known]);

  let entry = inMemory;
  if (inMemory) {
    await tags.fetch(fetched);
  } else {
    const [found] = await Promise.all([read(), tags.fetch(fetched)]);
    entry = found;
  }
  if (!entry) return undefined;

  const missing = entry.tags.filter((tag) => !fetched.has(tag));
  if (missing.length > 0) await tags.fetch(missing);
  if (!inMemory) stores.entryTags.set(redisKey, entry.tags, entry.tags.length, null);
  return entry;
}
