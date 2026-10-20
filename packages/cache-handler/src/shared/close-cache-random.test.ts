/**
 * Random sequences of runtimes, revalidations (immediate or with durations), flushes, entry
 * writes and reads, closes (awaited or overlapping the next steps), Redis going down and coming
 * back, and Redis refusing or holding tag record writes (the hash) and tag index writes (the sorted
 * set) apart, on two connections of the package's own and one application client. The clock is
 * controlled and moves before every revalidation, so two revalidations of a tag never share a
 * time and one's acknowledgement cannot stand for the other's.
 *
 * After every step, each invalidation issued so far is in Redis (hash and index) or visible to
 * the live runtime of its key (or, with none, in the state kept for it); and a read never serves
 * an entry an invalidation made after it as fresh. At the end, with Redis up and taking writes, a
 * runtime for every key and a `closeCache()` leave every invalidation in Redis, no tag state and
 * no connection of the package's own open.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FakeRedis } from "../testing/fake-redis.js";

const redis = vi.hoisted(() => ({
  items: new Map(),
  /** Every client the package opened, and whether it was quit or disconnected. */
  opened: [] as { client: FakeRedis; closed: boolean }[],
  /** Tag record writes (EVALSHA) and tag index writes (ZADD) refused with READONLY. */
  refuse: { hash: false, index: false },
  /** When set, the next tag write of that kind is held until a later step releases it. */
  stall: undefined as "hash" | "index" | undefined,
  /** Held tag writes: the step that held each, and its release. */
  held: [] as { step: number; release: () => void }[],
  step: 0,
}));

/** A tag write: held if a stall of its kind is armed, then refused while Redis refuses it. */
async function tagWrite<T>(kind: "hash" | "index", write: () => Promise<T>): Promise<T> {
  if (redis.stall === kind) {
    redis.stall = undefined;
    await new Promise<void>((release) => redis.held.push({ step: redis.step, release }));
  }
  if (redis.refuse[kind]) {
    throw new Error("READONLY You can't write against a read only replica.");
  }
  return write();
}

/** Route `client`'s tag writes through {@link tagWrite}. */
function watchTagWrites(client: FakeRedis): void {
  const evalsha = client.evalsha.bind(client);
  const zadd = client.zadd.bind(client);
  vi.spyOn(client, "evalsha").mockImplementation((...args) =>
    tagWrite("hash", () => evalsha(...args)),
  );
  vi.spyOn(client, "zadd").mockImplementation((...args) => tagWrite("index", () => zadd(...args)));
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
        const opened = { client, closed: false };
        redis.opened.push(opened);
        watchTagWrites(client);
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

import { createRemoteCacheHandler } from "../data-cache/remote.js";
import type { DataCacheEntry } from "../data-cache/types.js";
import { closeCache, flushCache } from "../index.js";
import { asClient, resetCacheState } from "../testing/env.js";
import { setClockForTests } from "./clock.js";
import { getClientConnection } from "./connection.js";
import { buildFlushTag, tagIndexKey, tagsKey } from "./keys.js";
import { type CacheRuntime, type RuntimeOptions, getCacheRuntime } from "./runtime.js";
import type { KeyTagState } from "./tag-store.js";

const SEEDS = 1000;
const STEPS = 30;
const url = "redis://random-test:6379";
const TAGS = ["t0", "t1", "t2"];

/**
 * The kinds of step, weighted: revalidations, closes and held writes are where invalidations can be
 * lost, so they come up more often than outages, entry writes and reads.
 */
const STEP_KINDS = [
  ...["acquire", "flush", "refuse", "accept", "sync", "down", "up", "write", "read", "wait"],
  ...["update", "update", "update", "close", "close", "hold", "hold"],
] as const;

/** The controlled clock: moved only by the test. */
const clock = { now: 1_800_000_000_000 };

function entry(tag: string, timestamp: number): Promise<DataCacheEntry> {
  return Promise.resolve({
    value: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(tag));
        controller.close();
      },
    }),
    tags: [tag],
    stale: 30,
    timestamp,
    expire: 300,
    revalidate: 60,
  });
}

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

/** Whether Redis holds the invalidation of `tag` made `at`: in the record hash and the index. */
function inRedis(key: Key, tag: string, at: number): boolean {
  const prefix = key.options.keyPrefix as string;
  const hash = key.items.get(tagsKey(prefix)) as { value: Map<string, string> } | undefined;
  const index = key.items.get(tagIndexKey(prefix)) as { value: Map<string, number> } | undefined;
  return stale(hash?.value.get(tag)) >= at && (index?.value.get(tag) ?? 0) >= at;
}

/** One sequence; `trace` gets each step's action. */
async function run(seed: number, trace: string[]): Promise<void> {
  const random = prng(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const appClient = new FakeRedis();
  watchTagWrites(appClient);
  // Its connection exists before Redis can go down, so no step waits for a first connect.
  getClientConnection(asClient(appClient));
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
  const handlers = new Map(
    keys.map((key) => [key, createRemoteCacheHandler({ ...key.options, buildId: "b1" })]),
  );
  const clients = () => [appClient, ...redis.opened.filter((o) => !o.closed).map((o) => o.client)];
  const runtimes: { key: Key; runtime: CacheRuntime }[] = [];
  const issued: {
    key: Key;
    tag: string;
    at: number;
    durations: { expire: number } | undefined;
    step: string;
  }[] = [];
  const entries: { key: Key; name: string; tag: string; timestamp: number }[] = [];
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

  /** Read an entry: one an invalidation made after it is never fresh, and a miss when that is immediate. */
  const read = async (written: (typeof entries)[number]): Promise<string> => {
    const found = await handlers.get(written.key)?.get(written.name, []);
    const later = issued.filter(
      (i) => i.key === written.key && i.tag === written.tag && i.at > written.timestamp,
    );
    if (later.length === 0) return found ? "hit" : "miss";
    if (found && found.revalidate !== -1) {
      throw new Error(
        `${written.name} on ${written.key.name} is served fresh after ${later[0]?.step}`,
      );
    }
    // A revalidation with durations, even an earlier one replayed later, can leave it stale.
    const durationsUsed = issued.some(
      (i) => i.key === written.key && i.tag === written.tag && i.durations,
    );
    if (found && !durationsUsed) {
      throw new Error(`${written.name} on ${written.key.name} is served after ${later[0]?.step}`);
    }
    return found ? "stale" : "miss";
  };

  for (let step = 0; step < STEPS; step++) {
    redis.step = step;
    const choice = pick(STEP_KINDS);
    const key = pick(keys);
    let action: string;
    if (choice === "acquire") {
      action = `acquire ${key.name}`;
      runtimes.push({ key, runtime: getCacheRuntime(key.options) });
    } else if (choice === "update" && runtimes.length > 0) {
      const { key: owner, runtime } = pick(runtimes);
      const tag = pick(TAGS);
      const durations = random() < 0.3 ? { expire: 1 + Math.floor(random() * 2) } : undefined;
      clock.now += 1 + Math.floor(random() * 3);
      action = `update ${tag}${durations ? ` expire ${durations.expire}` : ""} on ${runtime.closed ? "closed" : "live"} ${owner.name}`;
      issued.push({ key: owner, tag, at: clock.now, durations, step: action });
      action += `, ${await perform(runtime.tags.update([tag], durations))}`;
    } else if (choice === "flush" && !key.client) {
      action = `flush ${key.name}`;
      clock.now += 1;
      const at = clock.now;
      const flush = flushCache({ ...key.options, buildId: "b1" }).then(
        // Counted only once it resolves: a flush on a connection of its own throws when Redis
        // refuses the barrier, and says so.
        () =>
          issued.push({
            key,
            tag: buildFlushTag("b1"),
            at,
            durations: undefined,
            step: `flush ${key.name}`,
          }),
        () => undefined,
      );
      action += `, ${await perform(flush)}`;
    } else if (choice === "close") {
      action = `closeCache, ${await perform(closeCache())}`;
    } else if (choice === "refuse") {
      const kind = pick(["hash", "index", "both"] as const);
      action = `Redis refuses tag writes (${kind})`;
      redis.refuse = { hash: kind !== "index", index: kind !== "hash" };
    } else if (choice === "accept") {
      action = "Redis accepts tag writes";
      redis.refuse = { hash: false, index: false };
    } else if (choice === "hold") {
      redis.stall = pick(["hash", "index"] as const);
      action = `Redis holds the next tag write (${redis.stall})`;
    } else if (choice === "sync") {
      action = "sync";
      if (runtimes.length > 0) action += `, ${await perform(pick(runtimes).runtime.tags.sync())}`;
    } else if (choice === "down") {
      action = "Redis goes down";
      for (const client of clients()) if (client.status === "ready") client.goDown();
    } else if (choice === "up") {
      action = "Redis comes back";
      for (const client of clients()) if (client.status === "reconnecting") client.comeUp();
    } else if (choice === "write") {
      const tag = pick(TAGS);
      const name = `e${step}`;
      const timestamp = clock.now;
      action = `write ${name} (${tag}) on ${key.name}`;
      await handlers.get(key)?.set(name, entry(tag, timestamp));
      entries.push({ key, name, tag, timestamp });
    } else if (choice === "read" && entries.length > 0) {
      const written = pick(entries);
      action = `read ${written.name} on ${written.key.name}: ${await read(written)}`;
    } else {
      action = "3 s pass";
      clock.now += 3000;
    }
    // A write held in an earlier step is answered now; then whatever can run, runs.
    for (const held of redis.held.filter((held) => held.step < step)) held.release();
    redis.held = redis.held.filter((held) => held.step >= step);
    await new Promise((resolve) => setImmediate(resolve));
    trace.push(action);
    check(`step ${step}: ${action}`);
  }

  redis.stall = undefined;
  for (const held of redis.held) held.release();
  redis.held = [];
  await Promise.allSettled(running);
  redis.refuse = { hash: false, index: false };
  for (const client of clients()) if (client.status === "reconnecting") client.comeUp();
  // A state kept for a key is sent once a runtime of the key exists.
  for (const key of keys) getCacheRuntime(key.options);
  for (const written of entries) await read(written);
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
    // Refused writes and outages are logged; thousands of them here.
    for (const level of ["error", "warn", "info"] as const) {
      vi.spyOn(console, level).mockImplementation(() => {});
    }
    setClockForTests(() => clock.now);
    await resetCacheState();
    redis.items.clear();
    redis.opened.length = 0;
  });

  afterEach(async () => {
    setClockForTests(() => Date.now());
    redis.refuse = { hash: false, index: false };
    redis.stall = undefined;
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
