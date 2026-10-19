/**
 * One tag store per process (per connection and key prefix), shared by the page, remote and local
 * handlers. It implements Next's Distributed Tag Coordination pattern:
 * https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers#distributed-tag-coordination
 *
 * Redis layout (two keys per prefix, whatever the number of tags):
 * - `<prefix>tags`, a hash: field = tag, value = `"<stale>,<expired>"` (ms since the epoch).
 * - `<prefix>tag-index`, a sorted set of the same tags scored by their last update (ms). Each
 *   tag appears once; it is trimmed by age only, so it never loses an update.
 *
 * - `update` (from `updateTags` and the page handler's `revalidateTag`) records the invalidation in
 *   local state, then sends one HSET of every tag and one ZADD to the index (plus their EXPIRE).
 * - `fetch` reads named records with one HMGET and merges them. The page handler sends it with its
 *   entry GET, in one round trip, because Next reads the singular `cacheHandler` before any
 *   `refreshTags` (next/dist/server/async-storage/work-store.js creates refreshTags lazily and
 *   only use-cache-wrapper.js awaits it).
 * - `sync` (`refreshTags`, at most every 100 ms) reads the index entries updated since the last
 *   sync minus a skew margin, then HMGETs only those tags: one ZRANGEBYSCORE while nothing
 *   changed. The first sync of a process reads the whole index, in pages of
 *   {@link SYNC_PAGE_SIZE}.
 * - `check` and `getExpiration` read local state only: no Redis call per lookup.
 * - Tags not updated for the tag TTL (366 days) are removed from both keys, at most hourly per
 *   process, a bounded batch at a time.
 *
 * While Redis is down only local tags apply, and an `update` reaches this process only (a warning
 * is logged). On reconnect the next sync catches up on every invalidation made since the last one.
 * Writers' clocks may differ by up to {@link SYNC_SKEW_MS}; a larger skew can delay an
 * invalidation on other instances until the tag is updated again.
 *
 * Record semantics are 16.5.1's (see `../data-cache/redis.ts`): every update sets `stale = now`;
 * without durations it also sets `expired = now` (immediate), and with `durations.expire` it sets
 * `expired = now + expire` (served stale until then).
 */

import { type ErrorReporter, createErrorReporter } from "../data-cache/error-reporter.js";
import type { RedisConnection } from "./connection.js";
import { TAG_TTL_SECONDS, tagIndexKey, tagsKey } from "./keys.js";

/**
 * Tags read per round trip by a sync.
 */
export const SYNC_PAGE_SIZE = 1_000;

/**
 * Most expired tags removed from Redis by one prune.
 */
const REMOTE_PRUNE_BATCH = 500;

/**
 * How far before the last sync point a sync reads again, to absorb clock skew between writers.
 */
export const SYNC_SKEW_MS = 5_000;

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * When a tag was last invalidated, in ms since the epoch.
 */
export interface TagRecord {
  /** Entries created before this are stale (served once more, regenerated in the background). */
  stale?: number;
  /** Entries created before this are expired once this time has passed. */
  expired?: number;
}

/**
 * The state of an entry given its tags.
 */
export type TagState = "fresh" | "stale" | "expired";

/**
 * `"<stale>,<expired>"`, either part empty when unset.
 */
export function encodeRecord(record: TagRecord): string {
  return `${record.stale ?? ""},${record.expired ?? ""}`;
}

/**
 * The record in a hash value, or `undefined` for a missing or malformed one.
 */
export function decodeRecord(raw: string | null | undefined): TagRecord | undefined {
  if (!raw) return undefined;
  const [stale, expired] = raw.split(",");
  const record: TagRecord = {};
  if (stale) record.stale = Number(stale);
  if (expired) record.expired = Number(expired);
  if (Number.isNaN(record.stale) || Number.isNaN(record.expired)) return undefined;
  return record.stale === undefined && record.expired === undefined ? undefined : record;
}

/**
 * Apply an update made at `now` with `durations` to `existing`.
 */
export function applyUpdate(
  existing: TagRecord | undefined,
  now: number,
  durations?: { expire?: number },
): TagRecord {
  const record: TagRecord = { ...existing, stale: now };
  if (!durations) record.expired = now;
  else if (durations.expire !== undefined) record.expired = now + durations.expire * 1000;
  return record;
}

/**
 * Process-local tag state, synced with Redis when a connection is given.
 */
export class TagStore {
  private readonly records = new Map<string, TagRecord>();
  private readonly reportError: ErrorReporter;
  private syncedUpTo = 0;
  private lastSyncAt = 0;
  private lastPruneAt = Number.NEGATIVE_INFINITY;
  private lastRemotePruneAt = Number.NEGATIVE_INFINITY;
  private syncing: Promise<void> | undefined;
  private lastUpdate: { key: string; done: Promise<void> } | undefined;

  constructor(
    private readonly connection: RedisConnection | undefined,
    private readonly keyPrefix: string,
    options: { errorLogIntervalMs?: number } = {},
  ) {
    this.reportError = createErrorReporter("[RedisCache]:", options.errorLogIntervalMs);
  }

  /**
   * The local record of `tag`.
   */
  get(tag: string): TagRecord | undefined {
    return this.records.get(tag);
  }

  /**
   * Whether an entry created at `timestamp` with these tags is fresh, stale or expired. Local
   * state only.
   */
  check(tags: Iterable<string>, timestamp: number, now: number = Date.now()): TagState {
    let stale = false;
    for (const tag of tags) {
      const record = this.records.get(tag);
      if (!record) continue;
      // An immediate revalidation (`expired === stale`) applies whatever this clock says; one with
      // durations expires once `expired` has passed here.
      const immediate = record.expired === record.stale;
      if (
        record.expired !== undefined &&
        record.expired > timestamp &&
        (immediate || record.expired <= now)
      ) {
        return "expired";
      }
      if (record.stale !== undefined && record.stale > timestamp) stale = true;
    }
    return stale ? "stale" : "fresh";
  }

  /**
   * The most recent invalidation time of these tags (16.5.1's `getExpiration`: the `stale` time),
   * or 0. Local state only.
   */
  getExpiration(tags: string[]): number {
    let latest = 0;
    for (const tag of tags) {
      const stale = this.records.get(tag)?.stale ?? 0;
      if (stale > latest) latest = stale;
    }
    return latest;
  }

  /**
   * Invalidate `tags` here and, when Redis is ready, for every instance.
   *
   * Next calls `updateTags` on every handler and then the singular `revalidateTag`, synchronously
   * in one loop (next/dist/server/revalidation-utils.js), for one `revalidateTag()`. Identical
   * updates in the same synchronous run share one write; nothing can be cached between them. A
   * later identical update, however soon, is applied again.
   */
  update(tags: string[], durations?: { expire?: number }): Promise<void> {
    const now = Date.now();
    const key = JSON.stringify([[...tags].sort(), durations ?? null]);
    if (this.lastUpdate?.key === key) return this.lastUpdate.done;

    const written = new Map<string, TagRecord>();
    for (const tag of tags) {
      const record = applyUpdate(this.records.get(tag), now, durations);
      this.records.set(tag, record);
      written.set(tag, record);
    }

    const done = this.write(written, now);
    const lastUpdate = { key, done };
    this.lastUpdate = lastUpdate;
    queueMicrotask(() => {
      if (this.lastUpdate === lastUpdate) this.lastUpdate = undefined;
    });
    return done;
  }

  private async write(records: Map<string, TagRecord>, now: number): Promise<void> {
    const connection = this.connection;
    if (!connection || records.size === 0) return;

    await connection.waitForInitialConnection();
    if (!connection.isReady()) {
      this.reportError(
        "updateTags",
        new Error(
          `Redis unavailable, revalidation of [${[...records.keys()].join(", ")}] reached this process only; other instances keep their entries until they expire`,
        ),
      );
      return;
    }

    const client = connection.client;
    const hash = tagsKey(this.keyPrefix);
    const index = tagIndexKey(this.keyPrefix);
    const fields: Record<string, string> = {};
    const scores: (string | number)[] = [];
    for (const [tag, record] of records) {
      fields[tag] = encodeRecord(record);
      scores.push(now, tag);
    }
    try {
      await Promise.all([
        client.hset(hash, fields),
        client.zadd(index, ...scores),
        client.expire(hash, TAG_TTL_SECONDS),
        client.expire(index, TAG_TTL_SECONDS),
      ]);
      await this.pruneRemote(now);
    } catch (error) {
      this.reportError("updateTags", error);
    }
  }

  /**
   * Remove tags not updated for the tag TTL from Redis: no stored entry can still depend on them.
   * At most hourly per process and {@link REMOTE_PRUNE_BATCH} tags at a time.
   */
  private async pruneRemote(now: number): Promise<void> {
    const connection = this.connection;
    if (!connection || now - this.lastRemotePruneAt < PRUNE_INTERVAL_MS) return;
    this.lastRemotePruneAt = now;
    const client = connection.client;
    const index = tagIndexKey(this.keyPrefix);
    const cutoff = now - TAG_TTL_SECONDS * 1000;
    const old = await client.zrangebyscore(index, "-inf", cutoff, "LIMIT", 0, REMOTE_PRUNE_BATCH);
    if (old.length === 0) return;
    await Promise.all([client.hdel(tagsKey(this.keyPrefix), ...old), client.zrem(index, ...old)]);
  }

  /**
   * Copy invalidations made by other instances into local state. Concurrent calls share one
   * sync; a call within `minIntervalMs` of the last completed sync does nothing.
   */
  sync(minIntervalMs = 0): Promise<void> {
    if (!this.connection) return Promise.resolve();
    if (this.syncing) return this.syncing;
    if (minIntervalMs > 0 && Date.now() - this.lastSyncAt < minIntervalMs) {
      return Promise.resolve();
    }
    this.syncing = this.runSync().finally(() => {
      this.lastSyncAt = Date.now();
      this.syncing = undefined;
    });
    return this.syncing;
  }

  private async runSync(): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    await connection.waitForInitialConnection();
    if (!connection.isReady()) return;

    const client = connection.client;
    const index = tagIndexKey(this.keyPrefix);
    const since = this.syncedUpTo - SYNC_SKEW_MS;
    // An update that lands after this point is scored at least `startedAt - SYNC_SKEW_MS` by any
    // writer within the skew bound, so the next sync can start there.
    const startedAt = Date.now();

    try {
      let upTo = Math.max(this.syncedUpTo, startedAt);
      for (let offset = 0; ; offset += SYNC_PAGE_SIZE) {
        const changed = await client.zrangebyscore(
          index,
          since,
          "+inf",
          "WITHSCORES",
          "LIMIT",
          offset,
          SYNC_PAGE_SIZE,
        );
        const tags: string[] = [];
        for (let i = 0; i + 1 < changed.length; i += 2) {
          tags.push(changed[i]);
          upTo = Math.max(upTo, Number(changed[i + 1]));
        }
        await this.fetch(tags);
        if (tags.length < SYNC_PAGE_SIZE) break;
      }
      this.syncedUpTo = upTo;
      this.prune();
    } catch (error) {
      this.reportError("refreshTags", error);
    }
  }

  /**
   * Read the Redis records of `tags` with one HMGET and merge them into local state. Callers send
   * it alongside their entry read, so it costs no extra round trip; it is a single-key command,
   * so it works unchanged on a Cluster. Throws on a Redis error.
   */
  async fetch(tags: Iterable<string>): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    const list = [...new Set(tags)];
    if (list.length === 0) return;
    const raws = await connection.client.hmget(tagsKey(this.keyPrefix), ...list);
    list.forEach((tag, i) => {
      const remote = decodeRecord(raws[i]);
      if (remote) this.merge(tag, remote);
    });
  }

  /**
   * Keep whichever record is newer: a local update not yet in Redis (made during an outage) wins
   * over an older remote record.
   */
  private merge(tag: string, remote: TagRecord): void {
    const local = this.records.get(tag);
    if (!local || (remote.stale ?? 0) >= (local.stale ?? 0)) this.records.set(tag, remote);
  }

  /**
   * Forget records older than the tag TTL: no entry they could invalidate is still stored.
   */
  private prune(now: number = Date.now()): void {
    if (now - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = now;
    const cutoff = now - TAG_TTL_SECONDS * 1000;
    for (const [tag, record] of this.records) {
      if (Math.max(record.stale ?? 0, record.expired ?? 0) < cutoff) this.records.delete(tag);
    }
  }
}
