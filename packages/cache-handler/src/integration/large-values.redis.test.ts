/**
 * Large entries (1 to 5 MB) through the page and remote handlers against a real Redis: byte-exact
 * round trips, GET/SET latency against the 1 s default `commandTimeout`, the compressed (v3) size
 * of a 5 MB listing, and a stalled Redis during a big GET.
 *
 * Runs only when `CACHE_TEST_REDIS_URL` points at a disposable Redis running in the Docker
 * container named by `CACHE_TEST_REDIS_CONTAINER`; the stall test pauses and unpauses that
 * container.
 *
 * ```sh
 * docker run -d --name cache-test-redis -p 6390:6379 redis:7-alpine
 * CACHE_TEST_REDIS_URL=redis://localhost:6390 CACHE_TEST_REDIS_CONTAINER=cache-test-redis \
 *   pnpm --filter @mrjasonroy/cache-components-cache-handler test:redis
 * ```
 */

import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createRemoteCacheHandler } from "../data-cache/remote.js";
import type { DataCacheEntry } from "../data-cache/types.js";
import type { PageCacheValue } from "../handlers/page-types.js";
import { createRedisCacheHandler } from "../handlers/redis.js";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "../shared/connection.js";
import { getCacheRuntime } from "../shared/runtime.js";
import { resetCacheState } from "../testing/env.js";

const url = process.env.CACHE_TEST_REDIS_URL;
const container = process.env.CACHE_TEST_REDIS_CONTAINER;
const enabled = Boolean(url && container);

const MB = 1024 * 1024;
const SIZES = [1 * MB, 2.5 * MB, 5 * MB];
/** Local Redis moves 5 MB in tens of ms; half the command timeout is a generous bound. */
const LATENCY_BOUND_MS = DEFAULT_COMMAND_TIMEOUT_MS / 2;

function docker(...args: string[]): void {
  execFileSync("docker", args, { stdio: "ignore" });
}

/** Restore the container whatever state a test left it in. */
function restoreContainer(): void {
  for (const command of ["unpause", "start"]) {
    try {
      docker(command, container as string);
    } catch {
      // Not paused, or already running.
    }
  }
}

function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function timed<T>(run: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const result = await run();
  return [result, performance.now() - started];
}

/** Repetitive listing markup, like a search-results page, of exactly `size` bytes. */
function listingHtml(size: number, seed: string): string {
  const rows: string[] = [];
  let length = 0;
  for (let i = 0; length < size; i++) {
    const row = `<li class="result"><a href="/product/${seed}-${i}">Product ${i}</a><span class="price">$${(i * 7) % 1000}.99</span></li>`;
    rows.push(row);
    length += row.length;
  }
  return rows.join("").slice(0, size);
}

function bigPage(size: number, seed: string): PageCacheValue {
  return {
    kind: "APP_PAGE",
    html: listingHtml(size, seed),
    rscData: randomBytes(size),
    segmentData: new Map([["/_index", randomBytes(1024)]]),
    headers: { "x-next-cache-tags": "search,_N_T_/search/page" },
    status: 200,
  };
}

function streamEntry(bytes: Buffer): Promise<DataCacheEntry> {
  return Promise.resolve({
    value: new Response(bytes).body as ReadableStream<Uint8Array>,
    tags: ["search"],
    stale: 0,
    timestamp: Date.now(),
    expire: 300,
    revalidate: 60,
  });
}

async function bytesOf(found: DataCacheEntry | undefined): Promise<Buffer | undefined> {
  return found ? Buffer.from(await new Response(found.value).arrayBuffer()) : undefined;
}

const pageContext = { cacheControl: { revalidate: 60, expire: 300 } };
const pageGet = { kind: "APP_PAGE" };

function mb(size: number): string {
  return `${size / MB} MB`;
}

describe.runIf(enabled)("large values (real Redis)", () => {
  // Unique per test, so runs never see each other's keys.
  let prefix = "";
  let warn: ReturnType<typeof vi.spyOn>;

  /**
   * One Next instance's handlers. The reader (`n = 1`) is on the default `commandTimeout`; the
   * writer's differs by 1 ms, which gives it its own connection and memory, so a read on the
   * reader comes from Redis, not from the writer's memory.
   */
  function instance(n: number) {
    const options = {
      url,
      keyPrefix: prefix,
      ...(n === 1 ? {} : { commandTimeout: DEFAULT_COMMAND_TIMEOUT_MS + 1 + n }),
    };
    const Page = createRedisCacheHandler({ ...options, buildId: "build-1" });
    return {
      page: new Page({}),
      remote: createRemoteCacheHandler({ ...options, buildId: "build-1" }),
      connection: () => getCacheRuntime(options).connection,
    };
  }

  /**
   * Drops seen as the client sees them (`close`) and as the package logs them. The connection's
   * own counters are in `connection.stats()`.
   */
  function watchDrops(connection: ReturnType<ReturnType<typeof instance>["connection"]>) {
    let closes = 0;
    connection?.client.on("close", () => {
      closes += 1;
    });
    return {
      closes: () => closes,
      dropWarnings: () =>
        warn.mock.calls.filter((call: unknown[]) => String(call[0]).includes("stopped answering"))
          .length,
    };
  }

  beforeAll(() => {
    restoreContainer();
  });

  afterEach(async () => {
    restoreContainer();
    await resetCacheState();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await resetCacheState();
  });

  function setup() {
    prefix = `test:${randomUUID()}:`;
    vi.spyOn(console, "error").mockImplementation(() => {});
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  }

  test.each(SIZES)(
    "page handler: %d-byte html + RSC round-trip byte-exact",
    async (size) => {
      setup();
      const writer = instance(0);
      const reader = instance(1);
      const value = bigPage(size, "p");

      const [, setMs] = await timed(() => writer.page.set("/search", value, pageContext));
      const [found, getMs] = await timed(() => reader.page.get("/search", pageGet));
      console.log(
        `[large-values] page ${mb(size)} html + ${mb(size)} rsc: set ${setMs.toFixed(1)} ms, get ${getMs.toFixed(1)} ms`,
      );

      const got = found?.value as PageCacheValue | undefined;
      expect(got?.html).toBe(value.html);
      expect(Buffer.compare(got?.rscData as Buffer, value.rscData as Buffer)).toBe(0);
      expect(setMs).toBeLessThan(LATENCY_BOUND_MS);
      expect(getMs).toBeLessThan(LATENCY_BOUND_MS);
    },
    30_000,
  );

  test.each(SIZES)(
    "remote handler: %d-byte stream entry round-trips byte-exact",
    async (size) => {
      setup();
      const writer = instance(0);
      const reader = instance(1);
      const bytes = randomBytes(size);

      const [, setMs] = await timed(() => writer.remote.set("search", streamEntry(bytes)));
      const [found, getMs] = await timed(() => reader.remote.get("search", []));
      console.log(
        `[large-values] remote ${mb(size)}: set ${setMs.toFixed(1)} ms, get ${getMs.toFixed(1)} ms`,
      );

      const got = await bytesOf(found);
      expect(got?.byteLength).toBe(size);
      expect(Buffer.compare(got as Buffer, bytes)).toBe(0);
      expect(setMs).toBeLessThan(LATENCY_BOUND_MS);
      expect(getMs).toBeLessThan(LATENCY_BOUND_MS);
    },
    30_000,
  );

  test("remote handler: a 5 MB listing is stored Brotli-compressed (v3) and round-trips byte-exact", async () => {
    setup();
    const writer = instance(0);
    const reader = instance(1);
    const bytes = Buffer.from(listingHtml(5 * MB, "c"));

    const [, setMs] = await timed(() => writer.remote.set("listing", streamEntry(bytes)));
    const stored = await writer.connection()?.client.getBuffer(`${prefix}build-1:data:listing`);
    const [found, getMs] = await timed(() => reader.remote.get("listing", []));
    console.log(
      `[large-values] remote 5 MB listing, compressed: stored ${stored?.byteLength} bytes, set ${setMs.toFixed(1)} ms, get ${getMs.toFixed(1)} ms`,
    );

    expect(stored?.subarray(0, 3).toString("latin1")).toBe("NCH");
    expect(stored?.[3]).toBe(3);
    // The uncompressed v2 length is in the preamble.
    expect(stored?.readUInt32BE(5)).toBeGreaterThan(5 * MB);
    expect(stored?.byteLength).toBeLessThan(MB / 2);
    const got = await bytesOf(found);
    expect(got?.byteLength).toBe(5 * MB);
    expect(Buffer.compare(got as Buffer, bytes)).toBe(0);
    expect(setMs).toBeLessThan(LATENCY_BOUND_MS);
    expect(getMs).toBeLessThan(LATENCY_BOUND_MS);
  }, 30_000);

  test("a run of 5 MB GETs never trips the timeout counter or drops the connection", async () => {
    setup();
    const writer = instance(0);
    const reader = instance(1);
    const keys = ["a", "b", "c", "d"];
    for (const key of keys) {
      await writer.remote.set(key, streamEntry(randomBytes(5 * MB)));
      await writer.page.set(`/${key}`, bigPage(5 * MB, key), pageContext);
    }
    expect(await reader.remote.get("a", [])).toBeDefined();
    const drops = watchDrops(reader.connection());

    const timings: number[] = [];
    for (let round = 0; round < 5; round++) {
      for (const key of keys) {
        // A fresh instance per read keeps memory out of it; same options, same connection.
        const [found, ms] = await timed(() => reader.remote.get(key, []));
        expect((await bytesOf(found))?.byteLength).toBe(5 * MB);
        timings.push(ms);
        const [page, pageMs] = await timed(() => instance(1).page.get(`/${key}`, pageGet));
        expect((page?.value as PageCacheValue | undefined)?.html.length).toBe(5 * MB);
        timings.push(pageMs);
        expect(reader.connection()?.isReady()).toBe(true);
      }
    }
    const sorted = [...timings].sort((x, y) => x - y);
    console.log(
      `[large-values] ${timings.length} sequential 5 MB GETs: p50 ${sorted[Math.floor(sorted.length / 2)]?.toFixed(1)} ms, max ${sorted.at(-1)?.toFixed(1)} ms`,
    );

    expect(drops.closes()).toBe(0);
    expect(drops.dropWarnings()).toBe(0);
    expect(sorted.at(-1)).toBeLessThan(LATENCY_BOUND_MS);
  }, 120_000);

  test("a stalled Redis during concurrent 5 MB GETs is a miss, not a throw, and the connection recovers", async () => {
    setup();
    const writer = instance(0);
    const reader = instance(1);
    const values = new Map(["a", "b", "c"].map((key) => [key, randomBytes(5 * MB)]));
    for (const [key, bytes] of values) {
      await writer.remote.set(key, streamEntry(bytes));
      await writer.page.set(`/${key}`, bigPage(5 * MB, key), pageContext);
    }
    expect(await reader.remote.get("a", [])).toBeDefined();

    docker("pause", container as string);
    // Concurrent requests, as a busy server sends them: enough timed-out commands at once to
    // trip `maxConsecutiveTimeouts` and drop the connection.
    const [results, ms] = await timed(() =>
      Promise.all([
        ...[...values.keys()].map((key) => reader.remote.get(key, [])),
        ...[...values.keys()].map((key) => instance(1).page.get(`/${key}`, pageGet)),
      ]),
    );
    console.log(`[large-values] stalled: 6 concurrent 5 MB GETs all missed in ${ms.toFixed(0)} ms`);
    expect(results.slice(0, 3)).toEqual([undefined, undefined, undefined]);
    expect(results.slice(3)).toEqual([null, null, null]);
    expect(ms).toBeLessThan(DEFAULT_COMMAND_TIMEOUT_MS + 500);
    // The drop's `disconnect` closes the socket a moment later; wait for it.
    await waitFor(() => reader.connection()?.isReady() === false, 5_000);

    docker("unpause", container as string);
    await waitFor(() => reader.connection()?.isReady() === true);
    const drops = watchDrops(reader.connection());
    const dropsBefore = reader.connection()?.stats().drops;
    // Stays up: every read over the next 3 s is a hit, with no further drop. The late 5 MB
    // replies to the timed-out GETs must not be handed to later commands either.
    const until = Date.now() + 3_000;
    let reads = 0;
    while (Date.now() < until) {
      for (const [key, bytes] of values) {
        const got = await bytesOf(await reader.remote.get(key, []));
        expect(got?.byteLength, `read ${key} after unpause`).toBe(bytes.byteLength);
        expect(Buffer.compare(got as Buffer, bytes)).toBe(0);
        reads += 1;
      }
      await sleep(100);
    }
    console.log(`[large-values] after unpause: ${reads} reads, ${drops.closes()} drops`);
    expect(drops.closes()).toBe(0);
    expect(reader.connection()?.stats().drops).toBe(dropsBefore);
  }, 60_000);
});
