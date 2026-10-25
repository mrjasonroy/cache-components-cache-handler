/**
 * The in-process memory budget: a share of the V8 heap, split across the six memory stores.
 *
 * The budget is resolved once per runtime, when it is created, in this order (DEC-11):
 *
 * 1. `withCache(config, { memory })`, handed to the server process in {@link MEMORY_OPTIONS_ENV};
 * 2. `CACHE_MEMORY_MAX_MIB` / `CACHE_MEMORY_HEAP_PERCENT`;
 * 3. 10% of the heap limit.
 *
 * The first level that sets anything decides; within a level `maxMiB` wins over `heapPercent`.
 * This is the package's usual order (an option beats its environment variable, as `keyPrefix`
 * beats `CACHE_KEY_PREFIX`).
 */

import { type LoggerSource, processLogger, writeLog } from "./logger.js";
import type { MemoryStoreOptions } from "./memory-store.js";

/**
 * How much process memory the package's in-process caches may use.
 */
export interface MemoryOptions {
  /**
   * Share of the V8 heap limit (`v8.getHeapStatistics().heap_size_limit`), in percent. The
   * limit is a little above `--max-old-space-size`, since it includes the young generation
   * (496 MiB for `--max-old-space-size=448` on Node 22). More than 0 and less than 100.
   * @default 10
   */
  heapPercent?: number;

  /**
   * Absolute budget in MiB. Wins over `heapPercent`.
   */
  maxMiB?: number;
}

/** Keys a `memory` setting may have. */
const MEMORY_OPTION_KEYS = new Set(["heapPercent", "maxMiB"]);

/** A budget above this share of the heap limit is logged once per process as a warning. */
export const OVERSIZED_HEAP_SHARE = 0.5;

/** Default share of the heap limit, in percent. */
export const DEFAULT_HEAP_PERCENT = 10;

/**
 * The budget when the heap limit cannot be read (no `node:v8`: a non-Node runtime, or Next's edge
 * runtime, where the handlers keep nothing anyway) and no `maxMiB` is set: 98 MiB, the fixed
 * budget the stores had before it became a share of the heap.
 */
export const FALLBACK_BUDGET_MIB = 98;

/**
 * Private variable through which `withCache` hands its `memory` option (JSON) to the handlers.
 * `next dev`, `next build` and `next start` load `next.config` in the process that serves, so
 * the handlers read it there; a standalone `server.js` never loads `next.config`.
 */
export const MEMORY_OPTIONS_ENV = "__CACHE_COMPONENTS_MEMORY";

const MiB = 1024 * 1024;

/**
 * Each store's share of the budget, out of their sum (98): today's ratios.
 */
export const MEMORY_STORE_SHARES = {
  page: 16,
  pageFallback: 16,
  data: 16,
  dataFallback: 16,
  local: 32,
  entryTags: 2,
} as const;

/** The in-process stores, by name. */
export type MemoryStoreName = keyof typeof MEMORY_STORE_SHARES;

const TOTAL_SHARES = Object.values(MEMORY_STORE_SHARES).reduce((sum, share) => sum + share, 0);

/** Entry caps, which stay fixed whatever the budget. */
const MAX_ENTRIES: Partial<Record<MemoryStoreName, number>> = {
  local: 10_000,
  entryTags: 10_000,
};

/**
 * Throw unless `options` is a valid `memory` setting. `source` names it in the message.
 */
export function validateMemoryOptions(options: unknown, source: string): MemoryOptions {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error(`${source}: memory must be an object like { heapPercent: 10 }.`);
  }
  const unknown = Object.keys(options).filter((key) => !MEMORY_OPTION_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `${source}: unknown memory option ${unknown.map((key) => `"${key}"`).join(", ")}; the options are heapPercent and maxMiB.`,
    );
  }
  const { heapPercent, maxMiB } = options as Record<string, unknown>;
  if (heapPercent !== undefined) checkHeapPercent(heapPercent, `${source} memory.heapPercent`);
  if (maxMiB !== undefined) checkMaxMiB(maxMiB, `${source} memory.maxMiB`);
  return definedMemoryOptions({
    heapPercent: heapPercent as number | undefined,
    maxMiB: maxMiB as number | undefined,
  });
}

function checkHeapPercent(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 100) {
    throw new Error(
      `${name} must be a number more than 0 and less than 100 (a share of the V8 heap, in percent); got ${String(value)}.`,
    );
  }
  return value;
}

function checkMaxMiB(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite number of MiB more than 0; got ${String(value)}.`);
  }
  return value;
}

function definedMemoryOptions(options: MemoryOptions): MemoryOptions {
  return {
    ...(options.heapPercent === undefined ? {} : { heapPercent: options.heapPercent }),
    ...(options.maxMiB === undefined ? {} : { maxMiB: options.maxMiB }),
  };
}

function envNumber(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  // `Number` rejects trailing junk ("10%", "64MiB") that `parseFloat` would accept.
  return Number(raw);
}

function fromEnv(env: NodeJS.ProcessEnv): MemoryOptions {
  const heapPercent = envNumber(env, "CACHE_MEMORY_HEAP_PERCENT");
  const maxMiB = envNumber(env, "CACHE_MEMORY_MAX_MIB");
  return definedMemoryOptions({
    heapPercent:
      heapPercent === undefined
        ? undefined
        : checkHeapPercent(
            heapPercent,
            `CACHE_MEMORY_HEAP_PERCENT="${env.CACHE_MEMORY_HEAP_PERCENT}":`,
          ),
    maxMiB:
      maxMiB === undefined
        ? undefined
        : checkMaxMiB(maxMiB, `CACHE_MEMORY_MAX_MIB="${env.CACHE_MEMORY_MAX_MIB}":`),
  });
}

function fromWithCache(env: NodeJS.ProcessEnv): MemoryOptions {
  const raw = env[MEMORY_OPTIONS_ENV];
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${MEMORY_OPTIONS_ENV} is not valid JSON; it is set by withCache's memory.`);
  }
  return validateMemoryOptions(parsed, "withCache");
}

/**
 * The V8 heap limit in bytes, or `undefined` where `node:v8` is not available. Loaded through
 * `process.getBuiltinModule`, never imported, so the edge bundle stays free of `node:` modules.
 */
export function readHeapLimit(): number | undefined {
  try {
    const v8 = globalThis.process?.getBuiltinModule?.("node:v8") as
      | typeof import("node:v8")
      | undefined;
    const limit = v8?.getHeapStatistics().heap_size_limit;
    return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The memory settings in effect: `withCache`'s, else the environment's, else the default.
 * Throws on an invalid value.
 */
export function resolveMemoryOptions(env: NodeJS.ProcessEnv = process.env): MemoryOptions {
  const option = fromWithCache(env);
  if (option.maxMiB !== undefined || option.heapPercent !== undefined) return option;
  const environment = fromEnv(env);
  if (environment.maxMiB !== undefined || environment.heapPercent !== undefined) {
    return environment;
  }
  return { heapPercent: DEFAULT_HEAP_PERCENT };
}

/**
 * The budget in bytes: `maxMiB` if set, else `heapPercent` of `heapLimit`, else (no heap limit)
 * {@link FALLBACK_BUDGET_MIB}.
 */
export function resolveMemoryBudget(
  env: NodeJS.ProcessEnv = process.env,
  heapLimit: number | undefined = readHeapLimit(),
): number {
  const { heapPercent = DEFAULT_HEAP_PERCENT, maxMiB } = resolveMemoryOptions(env);
  if (maxMiB !== undefined) return Math.floor(maxMiB * MiB);
  if (heapLimit === undefined) return FALLBACK_BUDGET_MIB * MiB;
  return Math.floor((heapLimit * heapPercent) / 100);
}

let warnedOversized = false;

/**
 * Log once per process, as a warning, a budget above {@link OVERSIZED_HEAP_SHARE} of the heap
 * limit: the caches could then crowd out the app and run the heap out of memory.
 */
export function warnIfOversized(
  budgetBytes: number,
  heapLimit: number | undefined,
  logger: LoggerSource = processLogger,
): void {
  if (warnedOversized || heapLimit === undefined) return;
  if (budgetBytes <= heapLimit * OVERSIZED_HEAP_SHARE) return;
  warnedOversized = true;
  const percent = Math.round((budgetBytes / heapLimit) * 100);
  writeLog(
    logger,
    "warn",
    `[RedisCache]: the in-process cache budget (${(budgetBytes / MiB).toFixed(0)} MiB) is ${percent}% of V8's heap limit (${(heapLimit / MiB).toFixed(0)} MiB); above 50% the caches can crowd out the app and run the heap out of memory. Lower memory.heapPercent / maxMiB or CACHE_MEMORY_*, or raise --max-old-space-size.`,
  );
}

/** Test-only: warn again. */
export function resetMemoryBudgetWarningForTests(): void {
  warnedOversized = false;
}

/**
 * Split `budgetBytes` across the stores by {@link MEMORY_STORE_SHARES}. Each cap is rounded
 * down, so they sum to at most the budget.
 */
export function memoryStoreCaps(
  budgetBytes: number,
): Record<MemoryStoreName, MemoryStoreOptions & { maxBytes: number }> {
  const caps = {} as Record<MemoryStoreName, MemoryStoreOptions & { maxBytes: number }>;
  for (const [name, share] of Object.entries(MEMORY_STORE_SHARES) as [MemoryStoreName, number][]) {
    const maxEntries = MAX_ENTRIES[name];
    caps[name] = {
      maxBytes: Math.floor((budgetBytes * share) / TOTAL_SHARES),
      ...(maxEntries === undefined ? {} : { maxEntries }),
    };
  }
  return caps;
}
