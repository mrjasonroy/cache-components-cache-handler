import { describe, expect, test } from "vitest";
import { MemoryStore, clearAllMemoryStores } from "./memory-store.js";

describe("MemoryStore", () => {
  test("expires entries", () => {
    const store = new MemoryStore<string>();
    store.set("a", "x", 1, 1_000);
    expect(store.get("a", 999)).toBe("x");
    expect(store.get("a", 1_000)).toBeUndefined();
    store.set("b", "y", 1, null);
    expect(store.get("b", Number.MAX_SAFE_INTEGER)).toBe("y");
  });

  test("evicts the least recently used past maxEntries", () => {
    const store = new MemoryStore<number>({ maxEntries: 2 });
    store.set("a", 1, 1, null);
    store.set("b", 2, 1, null);
    store.get("a");
    store.set("c", 3, 1, null);
    expect(store.get("b")).toBeUndefined();
    expect(store.get("a")).toBe(1);
    expect(store.size).toBe(2);
  });

  test("evicts by bytes and refuses an entry larger than maxBytes", () => {
    const store = new MemoryStore<number>({ maxBytes: 10 });
    store.set("a", 1, 6, null);
    store.set("b", 2, 6, null);
    expect(store.get("a")).toBeUndefined();
    store.set("huge", 3, 11, null);
    expect(store.get("huge")).toBeUndefined();
    expect(store.get("b")).toBe(2);
  });

  test("clearAllMemoryStores empties every store and counts the entries", () => {
    clearAllMemoryStores();
    const one = new MemoryStore<number>();
    const two = new MemoryStore<number>();
    one.set("a", 1, 1, null);
    two.set("b", 2, 1, null);
    two.set("c", 3, 1, null);
    expect(clearAllMemoryStores()).toBe(3);
    expect(one.size + two.size).toBe(0);
  });
});
