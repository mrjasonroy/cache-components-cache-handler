/**
 * One tag store per process (per connection and key prefix), shared by the page, remote and local
 * handlers. It implements Next's Distributed Tag Coordination pattern:
 * https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers#distributed-tag-coordination
 *
 * Redis layout (two keys per prefix, whatever the number of tags):
 * - `<prefix>tags`, a hash: field = tag, value = `"<stale>,<expired>"` (ms since the epoch).
 * - `<prefix>tag-index`, a sorted set of the same tags scored by their last update (ms). Each
 *   tag appears once.
 *
 * Neither key has a TTL and nothing deletes a tag record: a record must outlive every entry it
 * can invalidate, and the records of every tag ever revalidated are small (see DEC-3 for growth).
 * Only `flushCache({ scope: "all" })` removes them.
 *
 * - `update` (from `updateTags` and the page handler's `revalidateTag`) records the invalidation in
 *   local state, then sends one script call that merges every tag's update into its record and
 *   one `ZADD GT` to the index. Both only ever move a record forward, so a write that reaches
 *   Redis after a newer one never undoes it (see `./tag-update.ts`). An update Redis did not
 *   acknowledge (an outage, an error) is sent again, the same way, with the next update, the
 *   next sync or on reconnect.
 * - `fetch` reads named records with one HMGET and merges them. The page and remote handlers send
 *   it with their entry GET, in one round trip, because Next reads the singular `cacheHandler`
 *   before any `refreshTags` (next/dist/server/async-storage/work-store.js creates refreshTags
 *   lazily and only use-cache-wrapper.js awaits it), and so a failed sync never lets them serve an
 *   invalidated entry.
 * - `sync` (`refreshTags`, at most every 100 ms) reads the index entries updated since the last
 *   sync minus a skew margin, then HMGETs only those tags: one ZRANGEBYSCORE while nothing
 *   changed. The first sync of a process reads the whole index, in pages of
 *   {@link SYNC_PAGE_SIZE} walked by score, never by offset (see {@link TagStore.readIndexFrom}).
 * - `check` and `getExpiration` read local state only: no Redis call per lookup.
 * - `isSynced` says whether local state may be trusted for a value only this process holds (the
 *   local handler's): with Redis, only once a sync has completed since the connection was last
 *   (re)established.
 *
 * While Redis is down only local tags apply, and an `update` reaches this process only (a warning
 * is logged) until Redis is back. On reconnect the next sync catches up on every invalidation
 * made since the last one. Writers' clocks may differ by up to {@link SYNC_SKEW_MS}; a larger
 * skew can delay an invalidation on other instances until the tag is updated again.
 *
 * Record semantics are `createCacheHandler`'s (see `../data-cache/redis.ts`): every update sets `stale = now`;
 * without durations it also sets `expired = now` (immediate), and with `durations.expire` it sets
 * `expired = now + expire` (served stale until then).
 */

import { nowMs } from "./clock.js";
import type { RedisConnection } from "./connection.js";
import { type ErrorReporter, createErrorReporter } from "./error-reporter.js";
import { tagIndexKey, tagsKey } from "./keys.js";
import type { LoggerSource } from "./logger.js";
import {
  type TagUpdate,
  UPDATE_TAGS_SCRIPT,
  UPDATE_TAGS_SHA,
  mergeUpdate,
  updateArgs,
} from "./tag-update.js";

/**
 * How often a data handler's `refreshTags` may sync tags, at most, in ms. Concurrent requests
 * share one sync.
 */
export const REFRESH_TAGS_INTERVAL_MS = 100;

/**
 * Tags read per round trip by a sync.
 */
export const SYNC_PAGE_SIZE = 1_000;

/**
 * How far before the last sync point a sync reads again, to absorb clock skew between writers.
 */
export const SYNC_SKEW_MS = 5_000;

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

type Durations = { expire?: number };

/**
 * The tag state of one connection and key prefix: the local records, and the updates Redis has
 * not acknowledged. One exists per key in the process (`shared/tag-states.ts`); the live tag store
 * of the key is its owner.
 */
export interface KeyTagState {
  readonly records: Map<string, TagRecord>;
  readonly unsent: Map<string, Durations | null>;
  /** The store that uses it; a newer one takes it over. */
  owner?: TagStore;
}

/** Where a store of a runtime `closeCache` can close sends what reaches it after the close. */
export interface TagStoreKey {
  /** The live store of the same connection and key prefix, created if there is none. */
  liveStore(): TagStore;
  /** The current state of the same connection and key prefix, created if there is none. */
  currentState(): KeyTagState;
}

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
  durations?: Durations,
): TagRecord {
  const record: TagRecord = { ...existing, stale: now };
  if (!durations) record.expired = now;
  else if (durations.expire !== undefined) record.expired = now + durations.expire * 1000;
  return record;
}

/**
 * The update made at `now` with `durations`: `expired` is left out when it keeps the stored one.
 */
function toUpdate(now: number, durations?: Durations): TagUpdate {
  if (!durations) return { stale: now, expired: now };
  if (durations.expire !== undefined) return { stale: now, expired: now + durations.expire * 1000 };
  return { stale: now };
}

/**
 * Process-local tag state, synced with Redis when a connection is given.
 */
export class TagStore {
  private readonly state: KeyTagState;
  private readonly reportError: ErrorReporter;
  private readonly key: TagStoreKey | undefined;
  /** Set by {@link close}: updates go to the live store of the key from then on. */
  private closed = false;
  private syncedUpTo = 0;
  private lastSyncAt = 0;
  private synced = false;
  /** Bumped each time the connection becomes ready; a sync started before counts for nothing. */
  private connectedSince = 0;
  private syncing: Promise<void> | undefined;
  /** Batches sent to Redis and not yet answered. */
  private readonly sending = new Set<Promise<void>>();
  private lastUpdate: { key: string; done: Promise<void> } | undefined;
  private readonly stopListening: (() => void) | undefined;

  /**
   * @param options.state The state of its key to use and own (a kept one is sent on), or a new
   *   one of its own.
   * @param options.key Where updates go once {@link close}d; without it, it is never closed.
   */
  constructor(
    private readonly connection: RedisConnection | undefined,
    private readonly keyPrefix: string,
    options: {
      errorLogIntervalMs?: number;
      state?: KeyTagState;
      key?: TagStoreKey;
      logger?: LoggerSource;
    } = {},
  ) {
    this.reportError = createErrorReporter(
      "[RedisCache]:",
      options.errorLogIntervalMs,
      options.logger,
    );
    this.key = options.key;
    this.state = options.state ?? { records: new Map(), unsent: new Map() };
    this.state.owner = this;
    this.stopListening = connection?.onReady(() => {
      this.connectedSince += 1;
      this.synced = false;
      this.lastSyncAt = 0;
      void this.send();
    });
    if (this.unsent.size > 0) void this.send();
  }

  /** Local records. */
  private get records(): Map<string, TagRecord> {
    return this.state.records;
  }

  /** Updates Redis has not acknowledged, by tag: their durations, `null` for an immediate one. */
  private get unsent(): Map<string, Durations | null> {
    return this.state.unsent;
  }

  /**
   * The local record of `tag`.
   */
  get(tag: string): TagRecord | undefined {
    return this.records.get(tag);
  }

  /**
   * Whether local state holds every invalidation another instance could have made: always without
   * Redis; with Redis, once a sync has completed since the connection was last (re)established.
   * It stays true through an outage that starts after such a sync.
   */
  isSynced(): boolean {
    return !this.connection || this.synced;
  }

  /**
   * Whether an entry created at `timestamp` with these tags is fresh, stale or expired. Local
   * state only.
   */
  check(tags: Iterable<string>, timestamp: number, now: number = nowMs()): TagState {
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
   * The most recent invalidation time of these tags (`createCacheHandler`'s `getExpiration`: the `stale` time),
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
  update(tags: string[], durations?: Durations): Promise<void> {
    if (this.closed && this.key) return this.key.liveStore().update(tags, durations);
    const now = nowMs();
    const key = JSON.stringify([[...tags].sort(), durations ?? null]);
    if (this.lastUpdate?.key === key) return this.lastUpdate.done;

    for (const tag of tags) {
      this.records.set(tag, applyUpdate(this.records.get(tag), now, durations));
      if (this.connection) this.queue(tag, durations ?? null);
    }

    const done = this.send();
    const lastUpdate = { key, done };
    this.lastUpdate = lastUpdate;
    queueMicrotask(() => {
      if (this.lastUpdate === lastUpdate) this.lastUpdate = undefined;
    });
    return done;
  }

  /** Stop following the connection's reconnects, for a store being dropped. */
  dispose(): void {
    this.stopListening?.();
  }

  /**
   * For `closeCache`: stop following the connection. From then on an update goes to the live
   * store of the key, and a send already started that fails is queued in the key's current state,
   * never in this store's own: the state may have been dropped, or taken over by a newer store.
   */
  close(): void {
    this.closed = true;
    this.dispose();
  }

  /**
   * For `closeCache`: wait for the batches in flight, then, if Redis is ready, send what is still
   * queued one last time. Never throws; whatever Redis does not take stays queued.
   */
  async drain(): Promise<void> {
    await this.inFlight();
    if (this.unsent.size > 0 && this.connection?.isReady()) await this.send();
  }

  /** Whether some update has not reached Redis yet. */
  hasUnsent(): boolean {
    return this.unsent.size > 0;
  }

  /**
   * Queue an update of `tag` for Redis. An immediate update outranks one with durations.
   */
  private queue(tag: string, durations: Durations | null): void {
    const queued = this.unsent.get(tag);
    this.unsent.set(tag, queued === null ? null : durations);
  }

  /**
   * Send every queued update to Redis: one script call and one `ZADD GT`, whatever the number of
   * tags. Both merge forward only, so this write cannot undo a newer one from another instance
   * that Redis acknowledged first. Updates that fail stay queued, for the next update, sync or
   * reconnect, and are sent the same way. A send that finds the queue already taken by another
   * resolves once that batch is answered, so no `update` resolves before Redis has its tags.
   *
   * Each update is applied again at the time it is sent, here and in Redis. An update replayed
   * after an outage then carries the newest `stale`: it reaches every instance as a new
   * invalidation, and can only invalidate entries cached since the original update once more.
   */
  private async send(): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    if (this.unsent.size === 0) return this.inFlight();

    await connection.waitForInitialConnection();
    if (!connection.isReady()) {
      this.reportError(
        "updateTags",
        new Error(
          `Redis unavailable, revalidation of [${[...this.unsent.keys()].join(", ")}] reached this process only; it is sent to Redis when the connection is back`,
        ),
      );
      return;
    }

    // Another send may have taken the queue while this one waited for the connection.
    if (this.unsent.size === 0) return this.inFlight();
    const batch = new Map(this.unsent);
    this.unsent.clear();
    const sent = this.sendBatch(connection, batch);
    this.sending.add(sent);
    await sent;
    this.sending.delete(sent);
  }

  private async inFlight(): Promise<void> {
    await Promise.all(this.sending);
  }

  private async sendBatch(
    connection: RedisConnection,
    batch: Map<string, Durations | null>,
  ): Promise<void> {
    const now = nowMs();
    const updates = new Map<string, TagUpdate>();
    const scores: (string | number)[] = [];
    for (const [tag, durations] of batch) {
      const update = toUpdate(now, durations ?? undefined);
      updates.set(tag, update);
      this.records.set(tag, mergeUpdate(this.records.get(tag), update));
      scores.push(now, tag);
    }
    try {
      const client = connection.client;
      await Promise.all([
        this.writeRecords(updateArgs(updates)),
        client.zadd(tagIndexKey(this.keyPrefix), "GT", ...scores),
      ]);
    } catch (error) {
      const state = this.closed && this.key ? this.key.currentState() : this.state;
      for (const [tag, durations] of batch) {
        // The update reaches the key's live store locally too, as well as on its next send.
        if (state !== this.state) {
          state.records.set(
            tag,
            mergeUpdate(state.records.get(tag), updates.get(tag) as TagUpdate),
          );
        }
        if (!state.unsent.has(tag)) state.unsent.set(tag, durations);
        else if (durations === null) state.unsent.set(tag, null);
      }
      this.reportError("updateTags", error);
    }
  }

  /**
   * Merge updates into their records in Redis with {@link UPDATE_TAGS_SCRIPT}: EVALSHA, and EVAL
   * when the server has not cached the script (NOSCRIPT).
   */
  private async writeRecords(args: string[]): Promise<void> {
    const client = (this.connection as RedisConnection).client;
    const key = tagsKey(this.keyPrefix);
    try {
      await client.evalsha(UPDATE_TAGS_SHA, 1, key, ...args);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("NOSCRIPT")) throw error;
      await client.eval(UPDATE_TAGS_SCRIPT, 1, key, ...args);
    }
  }

  /**
   * Copy invalidations made by other instances into local state. Concurrent calls share one
   * sync; a call within `minIntervalMs` of the last sync that reached Redis does nothing.
   */
  sync(minIntervalMs = 0): Promise<void> {
    if (!this.connection || this.closed) return Promise.resolve();
    if (this.syncing) return this.syncing;
    if (minIntervalMs > 0 && nowMs() - this.lastSyncAt < minIntervalMs) {
      return Promise.resolve();
    }
    this.syncing = this.runSync().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  private async runSync(): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    await connection.waitForInitialConnection();
    // Not stamped as a sync, so the next call tries again.
    if (!connection.isReady()) return;

    const connectedSince = this.connectedSince;
    const since = this.syncedUpTo - SYNC_SKEW_MS;
    // An update that lands after this point is scored at least `startedAt - SYNC_SKEW_MS` by any
    // writer within the skew bound, so the next sync can start there. Scores read are not used:
    // one from a writer whose clock runs ahead would move the start past a lagging writer's.
    const startedAt = nowMs();

    try {
      await this.readIndexFrom(connection.client, since);
      // Only once every score from `since` up has been read: a failed sync is retried whole.
      this.syncedUpTo = Math.max(this.syncedUpTo, startedAt);
      if (this.connectedSince === connectedSince) this.synced = true;
      // An update Redis refused while the connection stayed up (OOM, READONLY, a timeout) would
      // otherwise wait for this process's next revalidation or reconnect.
      if (this.unsent.size > 0) void this.send();
    } catch (error) {
      this.synced = false;
      this.reportError("refreshTags", error);
    }
    this.lastSyncAt = nowMs();
  }

  /**
   * Fetch the record of every tag scored `since` or later, a page of {@link SYNC_PAGE_SIZE} at a
   * time. Pages are walked by score, not by offset: a tag revalidated meanwhile only moves to a
   * higher score, so it is read again later and never shifts an unread tag out of reach. Each page
   * resumes at the previous page's last score, inclusive, so tags sharing that score are read
   * whole; a page with a single score throughout reads all that score's tags in one command.
   */
  private async readIndexFrom(client: RedisConnection["client"], since: number): Promise<void> {
    const index = tagIndexKey(this.keyPrefix);
    let min = String(since);
    for (;;) {
      const page = await client.zrangebyscore(
        index,
        min,
        "+inf",
        "WITHSCORES",
        "LIMIT",
        0,
        SYNC_PAGE_SIZE,
      );
      if (page.length < SYNC_PAGE_SIZE * 2) {
        await this.fetch(page.filter((_, i) => i % 2 === 0));
        return;
      }
      const lastScore = page[page.length - 1];
      if (page[1] === lastScore) {
        const tied = await client.zrangebyscore(index, lastScore, lastScore);
        for (let i = 0; i < tied.length; i += SYNC_PAGE_SIZE) {
          await this.fetch(tied.slice(i, i + SYNC_PAGE_SIZE));
        }
        min = `(${lastScore}`;
      } else {
        // Tags at the last score may continue on the next page, which starts at that score.
        await this.fetch(page.filter((_, i) => i % 2 === 0 && page[i + 1] !== lastScore));
        min = lastScore;
      }
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
}
