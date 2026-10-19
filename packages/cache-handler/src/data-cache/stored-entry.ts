/**
 * A `"use cache"` entry with its value read into bytes, as the remote and local handlers keep it.
 */

import { MAX_ENTRY_AGE_SECONDS } from "../shared/keys.js";
import { bufferToStream, streamToBuffer } from "../shared/runtime.js";
import type { TagStore } from "../shared/tag-store.js";
import type { DataCacheEntry } from "./types.js";

/**
 * Next's sentinel for "no expiry" (`INFINITE_CACHE` in next/dist/lib/constants).
 */
export const INFINITE_CACHE = 0xfffffffe;

/**
 * Lifetime in seconds of an entry without a finite `expire`.
 */
export const DEFAULT_DATA_TTL_SECONDS = 24 * 60 * 60;

/**
 * The stored form of a {@link DataCacheEntry}.
 */
export interface StoredDataEntry {
  value: Uint8Array;
  tags: string[];
  stale: number;
  timestamp: number;
  expire: number;
  revalidate: number;
}

/**
 * Await a pending entry and read its stream. `undefined` for a failed render (a rejected entry or
 * an errored stream), which Next already reports.
 */
export async function readPendingEntry(
  pendingEntry: Promise<DataCacheEntry>,
): Promise<StoredDataEntry | undefined> {
  try {
    const entry = await pendingEntry;
    const value = await streamToBuffer(entry.value);
    return {
      value,
      tags: entry.tags,
      stale: entry.stale,
      timestamp: entry.timestamp,
      expire: entry.expire,
      revalidate: entry.revalidate,
    };
  } catch {
    return undefined;
  }
}

/**
 * Seconds the entry may still be kept: until `timestamp + expire` (24 h for an infinite expire),
 * capped at the longest entry age so a tag record always outlives it.
 */
export function storedEntryTTL(entry: StoredDataEntry, now: number = Date.now()): number {
  const expire = entry.expire >= INFINITE_CACHE ? DEFAULT_DATA_TTL_SECONDS : entry.expire;
  const lifetime = Math.min(expire, MAX_ENTRY_AGE_SECONDS);
  return Math.ceil((entry.timestamp + lifetime * 1000 - now) / 1000);
}

/**
 * The entry to hand to Next, or `undefined` when it must not be served: past `until` (ms) or the
 * longest entry age, or carrying an expired tag. A stale tag returns it with `revalidate: -1`, so Next serves it once
 * more and regenerates it in the background.
 */
export function toDataCacheEntry(
  stored: StoredDataEntry,
  tags: TagStore,
  until: number,
  now: number = Date.now(),
): DataCacheEntry | undefined {
  if (now > until || now >= stored.timestamp + MAX_ENTRY_AGE_SECONDS * 1000) return undefined;
  const state = tags.check(stored.tags, stored.timestamp, now);
  if (state === "expired") return undefined;
  return {
    value: bufferToStream(stored.value),
    tags: stored.tags,
    stale: stored.stale,
    timestamp: stored.timestamp,
    expire: stored.expire,
    revalidate: state === "stale" ? -1 : stored.revalidate,
  };
}

/**
 * Track in-flight `set`s by key, so a `get` of the same key waits for it instead of missing.
 */
export function createPendingSets() {
  const pending = new Map<string, Promise<void>>();
  return {
    wait(key: string): Promise<void> | undefined {
      return pending.get(key);
    },
    async track(key: string, work: () => Promise<void>): Promise<void> {
      let resolve: () => void = () => {};
      const done = new Promise<void>((r) => {
        resolve = r;
      });
      pending.set(key, done);
      try {
        await work();
      } finally {
        resolve();
        if (pending.get(key) === done) pending.delete(key);
      }
    },
  };
}
