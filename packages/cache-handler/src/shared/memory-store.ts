/**
 * A size- and count-bounded LRU of entries with an optional expiry, used for every in-process
 * store: memory-only entries, the no-Redis mode, the outage fallback and `"use cache"` values.
 *
 * Every store registers itself on a `globalThis` registry so `flushCache` can empty all of them.
 */

import { nowMs } from "./clock.js";

const REGISTRY_KEY = Symbol.for("@mrjasonroy/cache-components-cache-handler/memory-stores");

export interface MemoryStoreOptions {
  /**
   * Oldest entries go first once the store holds this many.
   * @default 1000
   */
  maxEntries?: number;

  /**
   * Oldest entries go first once the stored size passes this many bytes. A larger entry is not
   * stored. An entry counts its given size plus its key's length.
   * @default 16MiB
   */
  maxBytes?: number;
}

interface StoredItem<T> {
  value: T;
  size: number;
  /** Milliseconds since the epoch, or `null` for no expiry. */
  expiresAt: number | null;
}

/**
 * Process-memory LRU.
 */
export class MemoryStore<T> {
  private readonly items = new Map<string, StoredItem<T>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private bytes = 0;

  constructor(options: MemoryStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 1000;
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    getRegistry().add(this as MemoryStore<unknown>);
  }

  /** Leave the registry, for a store dropped before the process ends. */
  unregister(): void {
    getRegistry().delete(this as MemoryStore<unknown>);
  }

  /** Number of entries held. */
  get size(): number {
    return this.items.size;
  }

  /**
   * The live value for `key`, marked most recently used, or `undefined`.
   */
  get(key: string, now: number = nowMs()): T | undefined {
    const item = this.items.get(key);
    if (!item) return undefined;
    this.items.delete(key);
    if (item.expiresAt !== null && now >= item.expiresAt) {
      this.bytes -= item.size;
      return undefined;
    }
    this.items.set(key, item);
    return item.value;
  }

  /** Bytes held: the sizes given to {@link set} plus the keys' lengths. */
  get byteSize(): number {
    return this.bytes;
  }

  /**
   * Store `value` (counted as `valueSize` bytes, plus the key) until `expiresAt` (ms), or forever
   * with `null`.
   */
  set(key: string, value: T, valueSize: number, expiresAt: number | null): void {
    this.delete(key);
    // Keys count: a `"use cache"` key carries the function's encoded arguments.
    const size = valueSize + key.length;
    if (size > this.maxBytes) return;
    while (this.items.size >= this.maxEntries || this.bytes + size > this.maxBytes) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    this.items.set(key, { value, size, expiresAt });
    this.bytes += size;
  }

  delete(key: string): void {
    const item = this.items.get(key);
    if (!item) return;
    this.items.delete(key);
    this.bytes -= item.size;
  }

  /**
   * Drop every entry and return how many there were.
   */
  clear(): number {
    const count = this.items.size;
    this.items.clear();
    this.bytes = 0;
    return count;
  }
}

/**
 * Approximate bytes held by a list of strings (tags): each string's characters at two bytes, plus
 * a fixed overhead per string and per list.
 */
export function stringListBytes(list: readonly string[]): number {
  let bytes = 32;
  for (const item of list) bytes += 32 + item.length * 2;
  return bytes;
}

function getRegistry(): Set<MemoryStore<unknown>> {
  const store = globalThis as unknown as Record<symbol, Set<MemoryStore<unknown>> | undefined>;
  let registry = store[REGISTRY_KEY];
  if (!registry) {
    registry = new Set();
    store[REGISTRY_KEY] = registry;
  }
  return registry;
}

/**
 * Empty every memory store in the process and return how many entries were dropped.
 */
export function clearAllMemoryStores(): number {
  let count = 0;
  for (const store of getRegistry()) count += store.clear();
  return count;
}
