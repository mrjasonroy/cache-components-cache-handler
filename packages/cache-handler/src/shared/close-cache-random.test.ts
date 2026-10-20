/**
 * Random sequences of runtimes, revalidations, flushes, closes (awaited or overlapping the next
 * step) and Redis refusing or taking writes, on two connections of the package's own and one
 * application client. After every step, each invalidation issued so far is visible to the live
 * runtime of its key (or, with none, in the state kept for it), or is in Redis. At the end, with
 * Redis taking writes, a runtime for every key and a `closeCache()` leave every invalidation in
 * Redis, no tag state and no connection of the package's own open.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FakeRedis } from "../testing/fake-redis.js";

const redis = vi.hoisted(() => ({
  items: new Map(),
  /** Every client the package opened, and whether it was quit or disconnected. */
  opened: [] as { closed: boolean }[],
  /** Tag writes are refused with READONLY while set. */
  readonly: false,
  /** When set, the next tag write is held until a later step releases it. */
  stall: false,
  /** Held tag writes: the step that held each, and its release. */
  held: [] as { step: number; release: () => void }[],
  step: 0,
}));

/** A tag write: held if a stall is armed, then refused while Redis refuses. */
async function tagWrite<T>(write: () => Promise<T>): Promise<T> {
  if (redis.stall) {
    redis.stall = false;
    await new Promise<void>((release) => redis.held.push({ step: redis.step, release }));
  }
  if (redis.readonly) throw new Error("READONLY You can't write against a read only replica.");
  return write();
}

// ioredis is loaded with `requireModule` (Node's `require`), which `vi.mock("ioredis")` cannot reach.
vi.mock("./node-require.js", async (importOriginal) => {
  const { FakeRedis: Fake } = await import("../testing/fake-redis.js");
  return {
    ...(await importOriginal<typeof import("./node-require.js")>()),
    requireModule: (moduleName: string) => {
      if (moduleName !== "ioredis") throw new Error(`Unexpected require for module: ${moduleName}`);
      return function Redis() {
        const client = new Fake(redis.items);
        const opened = { closed: false };
        redis.opened.push(opened);
        const evalsha = client.evalsha.bind(client);
        vi.spyOn(client, "evalsha").mockImplementation((...args) =>
          tagWrite(() => evalsha(...args)),
        );
        // A closed client takes no more commands.
        vi.spyOn(client, "quit").mockImplementation(async () => {
          opened.closed = true;
          client.status = "end";
          return "OK";
        });
        vi.spyOn(client, "disconnect").mockImplementation(() => {
          opened.closed = true;
          client.status = "end";
        });
        return client;
      };
    },
  };
});

import { closeCache, flushCache } from "../index.js";
import { asClient, resetCacheState } from "../testing/env.js";
import { buildFlushTag, tagsKey } from "./keys.js";
import { type CacheRuntime, type RuntimeOptions, getCacheRuntime } from "./runtime.js";
import type { KeyTagState } from "./tag-store.js";

const SEEDS = 500;
const STEPS = 20;
const url = "redis://random-test:6379";
const TAGS = ["t0", "t1", "t2"];

/** mulberry32: a small seeded PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Key {
  readonly name: string;
  readonly options: RuntimeOptions;
  readonly items: Map<string, unknown>;
  /** The application client, for a key on one. */
  readonly client?: FakeRedis;
}

function stale(raw: string | undefined): number {
  return raw === undefined ? 0 : Number(raw.split(",")[0]);
}

/** The live runtime of `key`, without creating one. */
function liveRuntime(key: Key): CacheRuntime | undefined {
  const registry = (globalThis as unknown as Record<symbol, Map<string, CacheRuntime>>)[
    Symbol.for("@mrjasonroy/cache-components-cache-handler/runtimes")
  ];
  for (const runtime of registry?.values() ?? []) {
    const stateKey = (runtime as unknown as { stateKey?: { client?: object; keyPrefix: string } })
      .stateKey;
    const keyPrefix = key.options.keyPrefix as string;
    if (stateKey?.keyPrefix === keyPrefix && stateKey.client === key.client && !runtime.closed) {
      return runtime;
    }
  }
  return undefined;
}

function tagStates(): {
  pooled: Map<string, KeyTagState>;
  clients: WeakMap<object, Map<string, KeyTagState>>;
} {
  return (
    (globalThis as unknown as Record<symbol, ReturnType<typeof tagStates>>)[
      Symbol.for("@mrjasonroy/cache-components-cache-handler/tag-states")
    ] ?? { pooled: new Map(), clients: new WeakMap() }
  );
}

/** The state of `key` in the registry, if any. */
function keptState(key: Key): KeyTagState | undefined {
  const keyPrefix = key.options.keyPrefix as string;
  const states = tagStates();
  if (key.client) return states.clients.get(key.client)?.get(keyPrefix);
  for (const [slotKey, state] of states.pooled) {
    if (slotKey.endsWith(`|${keyPrefix}`)) return state;
  }
  return undefined;
}

function inRedis(key: Key, tag: string, at: number): boolean {
  const hash = key.items.get(tagsKey(key.options.keyPrefix as string)) as
    | { value: Map<string, string> }
    | undefined;
  return stale(hash?.value.get(tag)) >= at;
}

/** One sequence; `trace` gets each step's action. */
async function run(seed: number, trace: string[]): Promise<void> {
  const random = prng(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  redis.readonly = false;
  const appClient = new FakeRedis();
  const appEvalsha = appClient.evalsha.bind(appClient);
  vi.spyOn(appClient, "evalsha").mockImplementation((...args) =>
    tagWrite(() => appEvalsha(...args)),
  );
  const keys: Key[] = [
    { name: "pooled a:", options: { url, keyPrefix: "a:" }, items: redis.items },
    { name: "pooled b:", options: { url, keyPrefix: "b:" }, items: redis.items },
    {
      name: "client a:",
      options: { client: asClient(appClient), keyPrefix: "a:" },
      items: appClient.items as Map<string, unknown>,
      client: appClient,
    },
  ];
  const runtimes: { key: Key; runtime: CacheRuntime }[] = [];
  const issued: { key: Key; tag: string; at: number; step: string }[] = [];
  /** Work left running past its step, settled at the end. */
  const running: Promise<unknown>[] = [];
  /** Awaited at once while no write is held, or left running into the next steps. */
  const perform = async (work: Promise<unknown>): Promise<string> => {
    if (!redis.stall && redis.held.length === 0 && random() < 0.5) {
      await work;
      return "awaited";
    }
    running.push(work);
    return "overlapping";
  };

  const check = (when: string) => {
    for (const { key, tag, at, step } of issued) {
      if (inRedis(key, tag, at)) continue;
      const live = liveRuntime(key);
      const local = live ? live.tags.get(tag)?.stale : keptState(key)?.records.get(tag)?.stale;
      if ((local ?? 0) >= at) continue;
      throw new Error(
        `${tag} on ${key.name} (${step}) is neither in Redis nor visible ${live ? "to the live runtime" : "in the kept state"} after ${when}`,
      );
    }
  };

  for (let step = 0; step < STEPS; step++) {
    redis.step = step;
    const choice = Math.floor(random() * 9);
    const key = pick(keys);
    let action: string;
    if (choice === 0) {
      action = `acquire ${key.name}`;
      runtimes.push({ key, runtime: getCacheRuntime(key.options) });
    } else if (choice <= 2 && runtimes.length > 0) {
      const { key: owner, runtime } = pick(runtimes);
      const tag = pick(TAGS);
      action = `update ${tag} on ${runtime.closed ? "closed" : "live"} ${owner.name}`;
      issued.push({ key: owner, tag, at: Date.now(), step: action });
      action += `, ${await perform(runtime.tags.update([tag]))}`;
    } else if (choice === 3 && !key.client) {
      action = `flush ${key.name}`;
      const at = Date.now();
      const flush = flushCache({ ...key.options, buildId: "b1" }).then(
        // Counted only once it resolves: a flush on a connection of its own throws when Redis
        // refuses the barrier, and says so.
        () => issued.push({ key, tag: buildFlushTag("b1"), at, step: `flush ${key.name}` }),
        () => undefined,
      );
      action += `, ${await perform(flush)}`;
    } else if (choice === 4) {
      action = `closeCache, ${await perform(closeCache())}`;
    } else if (choice === 5) {
      action = "Redis refuses";
      redis.readonly = true;
    } else if (choice === 6) {
      action = "Redis accepts";
      redis.readonly = false;
    } else if (choice === 7) {
      action = "Redis holds the next tag write";
      redis.stall = true;
    } else {
      action = "sync";
      if (runtimes.length > 0) action += `, ${await perform(pick(runtimes).runtime.tags.sync())}`;
    }
    // A write held in an earlier step is answered now; then whatever can run, runs.
    for (const held of redis.held.filter((held) => held.step < step)) held.release();
    redis.held = redis.held.filter((held) => held.step >= step);
    await new Promise((resolve) => setImmediate(resolve));
    trace.push(action);
    check(`step ${step}: ${action}`);
  }

  redis.stall = false;
  for (const held of redis.held) held.release();
  redis.held = [];
  await Promise.allSettled(running);
  redis.readonly = false;
  // A state kept for a key is sent once a runtime of the key exists.
  for (const key of keys) getCacheRuntime(key.options);
  await closeCache();
  check("the final close");

  const missing = issued.filter(({ key, tag, at }) => !inRedis(key, tag, at));
  expect(missing.map(({ key, tag, step }) => `${tag} on ${key.name} (${step})`)).toEqual([]);
  expect(tagStates().pooled.size).toBe(0);
  expect(tagStates().clients.get(appClient)).toBeUndefined();
  expect(redis.opened.filter((client) => !client.closed)).toHaveLength(0);
}

describe("closeCache, random sequences", () => {
  beforeEach(async () => {
    // Refused writes are logged; thousands of them here.
    vi.spyOn(console, "error").mockImplementation(() => {});
    await resetCacheState();
    redis.items.clear();
    redis.opened.length = 0;
  });

  afterEach(async () => {
    redis.readonly = false;
    redis.stall = false;
    for (const held of redis.held) held.release();
    redis.held = [];
    await resetCacheState();
    vi.restoreAllMocks();
  });

  test(`${SEEDS} seeds of ${STEPS} steps lose no invalidation and leave nothing behind`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const trace: string[] = [];
      try {
        await run(seed, trace);
      } catch (error) {
        throw new Error(
          `seed ${seed}: ${error instanceof Error ? error.message : String(error)}\nsteps: ${trace.join("; ")}`,
          { cause: error },
        );
      }
      await resetCacheState();
      redis.items.clear();
      redis.opened.length = 0;
    }
  }, 30_000);
});
