import { afterEach, describe, expect, test, vi } from "vitest";
import {
  FALLBACK_BUDGET_MIB,
  MEMORY_OPTIONS_ENV,
  MEMORY_STORE_SHARES,
  memoryStoreCaps,
  readHeapLimit,
  resolveMemoryBudget,
  validateMemoryOptions,
} from "./memory-budget.js";

const MiB = 1024 * 1024;
const HEAP = 768 * MiB;

/** `node:v8` reporting `heapLimit`, through `process.getBuiltinModule`. */
function mockHeapLimit(heapLimit: number): void {
  const original = process.getBuiltinModule.bind(process);
  vi.spyOn(process, "getBuiltinModule").mockImplementation(((id: string) =>
    id === "node:v8"
      ? { getHeapStatistics: () => ({ heap_size_limit: heapLimit }) }
      : original(id)) as typeof process.getBuiltinModule);
}

describe("memory budget", () => {
  afterEach(() => vi.restoreAllMocks());

  test("defaults to 10% of the V8 heap limit", () => {
    mockHeapLimit(HEAP);
    expect(readHeapLimit()).toBe(HEAP);
    expect(resolveMemoryBudget({})).toBe(Math.floor(HEAP / 10));
    expect(resolveMemoryBudget({}, 448 * MiB) / MiB).toBeCloseTo(44.8, 5);
  });

  test("reads the real heap limit under Node", () => {
    expect(readHeapLimit()).toBeGreaterThan(0);
  });

  test("CACHE_MEMORY_HEAP_PERCENT sets the share", () => {
    expect(resolveMemoryBudget({ CACHE_MEMORY_HEAP_PERCENT: "25" }, HEAP)).toBe(192 * MiB);
  });

  test("CACHE_MEMORY_MAX_MIB sets an absolute budget and wins over CACHE_MEMORY_HEAP_PERCENT", () => {
    expect(resolveMemoryBudget({ CACHE_MEMORY_MAX_MIB: "200" }, HEAP)).toBe(200 * MiB);
    expect(
      resolveMemoryBudget({ CACHE_MEMORY_MAX_MIB: "200", CACHE_MEMORY_HEAP_PERCENT: "25" }, HEAP),
    ).toBe(200 * MiB);
  });

  test("withCache's memory wins over the environment, maxMiB over heapPercent", () => {
    const env = { CACHE_MEMORY_MAX_MIB: "200", CACHE_MEMORY_HEAP_PERCENT: "25" };
    expect(
      resolveMemoryBudget({ ...env, [MEMORY_OPTIONS_ENV]: '{"heapPercent":5}' }, HEAP) / MiB,
    ).toBeCloseTo(38.4, 5);
    expect(
      resolveMemoryBudget({ ...env, [MEMORY_OPTIONS_ENV]: '{"heapPercent":5,"maxMiB":64}' }, HEAP),
    ).toBe(64 * MiB);
    // An empty withCache setting leaves the environment in charge.
    expect(resolveMemoryBudget({ ...env, [MEMORY_OPTIONS_ENV]: "{}" }, HEAP)).toBe(200 * MiB);
  });

  test("without a heap limit (no node:v8) the budget is the fixed fallback; maxMiB still applies", () => {
    vi.spyOn(process, "getBuiltinModule").mockImplementation(
      (() => undefined) as unknown as typeof process.getBuiltinModule,
    );
    expect(readHeapLimit()).toBeUndefined();
    expect(resolveMemoryBudget({})).toBe(FALLBACK_BUDGET_MIB * MiB);
    expect(resolveMemoryBudget({ CACHE_MEMORY_HEAP_PERCENT: "50" })).toBe(
      FALLBACK_BUDGET_MIB * MiB,
    );
    expect(resolveMemoryBudget({ CACHE_MEMORY_MAX_MIB: "32" })).toBe(32 * MiB);
  });

  test("the fallback reproduces the earlier fixed caps", () => {
    const caps = memoryStoreCaps(FALLBACK_BUDGET_MIB * MiB);
    expect(caps.local).toEqual({ maxBytes: 32 * MiB, maxEntries: 10_000 });
    expect(caps.entryTags).toEqual({ maxBytes: 2 * MiB, maxEntries: 10_000 });
    expect(caps.page.maxBytes).toBe(16 * MiB);
  });

  test.each([1, 77 * MiB, 333_333_333, 4 * 1024 * MiB])(
    "a %d-byte budget is split by the store ratios and the caps sum to at most it",
    (budget) => {
      const caps = memoryStoreCaps(budget);
      let sum = 0;
      for (const [name, share] of Object.entries(MEMORY_STORE_SHARES)) {
        const cap = caps[name as keyof typeof MEMORY_STORE_SHARES].maxBytes;
        expect(cap, name).toBe(Math.floor((budget * share) / 98));
        sum += cap;
      }
      expect(sum).toBeLessThanOrEqual(budget);
      expect(sum).toBeGreaterThan(budget - 6);
      expect(caps.local.maxEntries).toBe(10_000);
      expect(caps.entryTags.maxEntries).toBe(10_000);
    },
  );

  test.each([
    ["CACHE_MEMORY_HEAP_PERCENT", "0"],
    ["CACHE_MEMORY_HEAP_PERCENT", "-5"],
    ["CACHE_MEMORY_HEAP_PERCENT", "100"],
    ["CACHE_MEMORY_HEAP_PERCENT", "ten"],
    ["CACHE_MEMORY_HEAP_PERCENT", "10%"],
    ["CACHE_MEMORY_HEAP_PERCENT", "Infinity"],
    ["CACHE_MEMORY_MAX_MIB", "0"],
    ["CACHE_MEMORY_MAX_MIB", "-1"],
    ["CACHE_MEMORY_MAX_MIB", "64MiB"],
    ["CACHE_MEMORY_MAX_MIB", "Infinity"],
  ])("rejects %s=%s", (name, value) => {
    expect(() => resolveMemoryBudget({ [name]: value }, HEAP)).toThrow(name);
  });

  test("an empty variable counts as unset", () => {
    expect(resolveMemoryBudget({ CACHE_MEMORY_HEAP_PERCENT: " " }, HEAP)).toBe(
      Math.floor(HEAP / 10),
    );
  });

  test.each([
    [{ heapPercent: 0 }, "memory.heapPercent"],
    [{ heapPercent: 100 }, "memory.heapPercent"],
    [{ heapPercent: Number.NaN }, "memory.heapPercent"],
    [{ heapPercent: "10" }, "memory.heapPercent"],
    [{ maxMiB: 0 }, "memory.maxMiB"],
    [{ maxMiB: -64 }, "memory.maxMiB"],
    [{ maxMiB: Number.POSITIVE_INFINITY }, "memory.maxMiB"],
    [null, "memory must be an object"],
    [10, "memory must be an object"],
  ])("rejects memory %o", (memory, message) => {
    expect(() => validateMemoryOptions(memory, "withCache")).toThrow(message);
  });

  test("keeps only the fields that are set", () => {
    expect(validateMemoryOptions({ heapPercent: 12.5, maxMiB: undefined }, "withCache")).toEqual({
      heapPercent: 12.5,
    });
  });
});
