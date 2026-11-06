import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  BLOG,
  POSTS_FALLBACK,
  appPageCtx,
  fallbackCtx,
  writeBuildOutput,
} from "../testing/build-output.js";
import { CacheProcess, compileConcurrencyWorker } from "../testing/concurrency.js";

const url = process.env.CACHE_TEST_REDIS_URL;
const epoch = 1_800_000_000_000;
let compiled: ReturnType<typeof compileConcurrencyWorker>;
const processes: CacheProcess[] = [];
const buildDirs: string[] = [];
let raw: Redis | undefined;
let prefix: string;

beforeAll(() => {
  compiled = compileConcurrencyWorker();
}, 120_000);
afterAll(() => {
  compiled?.cleanup();
  raw?.disconnect();
});
beforeEach(() => {
  prefix = `concurrency:${randomUUID()}:`;
});
afterEach(async () => {
  await Promise.all(processes.splice(0).map((worker) => worker.stop()));
  for (const directory of buildDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (raw) {
    const keys = await raw.keys(`${prefix}*`);
    if (keys.length) await raw.del(...keys);
  }
});

async function start(lane: string, extra: Record<string, unknown> = {}) {
  const worker = new CacheProcess(compiled.directory);
  processes.push(worker);
  if (lane === "redis" && !raw) raw = new Redis(url as string);
  await worker.call({
    op: "init",
    prefix,
    now: epoch,
    options: lane === "redis" ? { url } : {},
    ...extra,
  });
  return worker;
}

for (const lane of ["memory", "redis"]) {
  describe.skipIf(lane === "redis" && !url)(`${lane} isolated processes`, () => {
    test.each(["page-full", "page-postponed", "remote", "local"])(
      "%s: overlapping same-key renders before, across and after an invalidation burst",
      async (shape) => {
        const kind = shape.startsWith("page") ? "page" : shape;
        const a = await start(lane);
        const b = await start(lane);
        const invalidator = await start(lane);
        const writers = [a, b];
        const begin = (worker: CacheProcess, request: string, now: number, value: string) =>
          worker.call({
            op: "begin",
            kind,
            key: "same",
            request,
            now,
            value,
            tags: ["burst"],
            postponed: shape === "page-postponed",
          });
        const read = (worker: CacheProcess, now: number) =>
          worker.call({ op: "read", kind, key: "same", request: `read-${now}`, now });
        for (const worker of writers) {
          await begin(worker, "before", epoch, "before");
          await worker.call({ op: "finish", request: "before", now: epoch + 10 });
          expect((await read(worker, epoch + 20))?.value).toBe("before");
        }
        // Eight genuinely pending renders, each page render on its own request handler.
        for (let n = 0; n < 8; n++) await begin(writers[n % 2], `held-${n}`, epoch + 30 + n, "old");
        for (let n = 0; n < 4; n++) {
          const command = { op: "invalidate", tags: ["burst"], now: epoch + 50 + n * 10 };
          await invalidator.call(command);
          // Without a shared store there is no cross-process invalidation guarantee.
          if (lane === "memory") for (const worker of writers) await worker.call(command);
        }
        await Promise.all(
          writers.map(async (worker, index) => {
            for (let n = index; n < 8; n += 2)
              await worker.call({ op: "finish", request: `held-${n}`, now: epoch + 200 + n });
          }),
        );
        for (const worker of writers) expect(await read(worker, epoch + 400)).toBeNull();
        for (const worker of writers) {
          await begin(worker, "after", epoch + 500, "fresh");
          await worker.call({ op: "finish", request: "after", now: epoch + 510 });
        }
        // No retry-until-fresh: every first read following the completed burst must be fresh.
        for (const worker of writers)
          expect((await read(worker, epoch + 600))?.value).toBe("fresh");
      },
    );

    test.each(["full", "postponed"])(
      "%s build output cannot resurrect after an invalidation",
      async (shape) => {
        // Built an hour before the workers' fixed clock, not the real one.
        const build = writeBuildOutput({ ageMs: Date.now() - epoch + 60 * 60 * 1000 });
        buildDirs.push(dirname(build.serverDistDir));
        const key = shape === "full" ? BLOG : POSTS_FALLBACK;
        const context = shape === "full" ? appPageCtx : fallbackCtx;
        const tags = shape === "full" ? ["products"] : ["_N_T_/posts/[slug]/page"];
        const a = await start(lane, { serverDistDir: build.serverDistDir });
        const b = await start(lane, { serverDistDir: build.serverDistDir });
        const read = { op: "read", kind: "page", key, context, request: "built", now: epoch };
        expect(await a.call(read)).not.toBeNull();
        expect(await b.call(read)).not.toBeNull();
        await a.call({ op: "invalidate", tags, now: epoch + 1 });
        if (lane === "memory") await b.call({ op: "invalidate", tags, now: epoch + 1 });
        expect(await b.call({ ...read, now: epoch + 200 })).toBeNull();
        expect(await a.call({ ...read, now: epoch + 200 })).toBeNull();
        if (lane === "redis") {
          const restarted = await start(lane, { serverDistDir: build.serverDistDir });
          expect(await restarted.call({ ...read, now: epoch + 300 })).toBeNull();
        }
      },
    );

    test.each(["page", "remote", "local"])(
      "%s retains render start across later lookups and resets",
      async (kind) => {
        const worker = await start(lane);
        const begin = {
          op: "begin",
          kind,
          key: "timestamp",
          request: "request",
          tags: [],
          value: "first",
        };
        const read = { op: "read", kind, key: "timestamp", request: "request" };
        await worker.call({ ...begin, now: epoch });
        if (kind === "page") await worker.call({ ...read, now: epoch + 100 });
        await worker.call({ op: "finish", request: "request", now: epoch + 250 });
        expect((await worker.call({ ...read, now: epoch + 400 }))?.timestamp).toBe(epoch);
        if (kind === "page") {
          await worker.call({ ...begin, now: epoch + 500 });
          await worker.call({ op: "finish", request: "request", now: epoch + 600 });
          expect((await worker.call({ ...read, now: epoch + 700 }))?.timestamp).toBe(epoch);
          await worker.call({ op: "reset", request: "request" });
        }
        await worker.call({ ...begin, now: epoch + 800 });
        await worker.call({ op: "finish", request: "request", now: epoch + 900 });
        expect((await worker.call({ ...read, now: epoch + 1000 }))?.timestamp).toBe(epoch + 800);
      },
    );
    test.each(["page", "remote", "local"])(
      "%s: seeded interleavings match render-time freshness (180 seeds)",
      async (kind) => {
        const workers = [await start(lane), await start(lane)];
        expect((await workers[0].call({ op: "identity" }))?.pid).not.toBe(
          (await workers[1].call({ op: "identity" }))?.pid,
        );
        for (let seed = 1; seed <= 180; seed++) {
          let state = seed;
          const random = () => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return state;
          };
          let now = epoch + seed * 10000;
          const key = `seed-${seed}`;
          const tag = `tag-${seed}`;
          let invalidated = 0;
          const model: ({ value: string; timestamp: number } | null)[] = [null, null];
          const pending = new Map<number, { value: string; timestamp: number }>();
          const actions = ["begin-0", "begin-1", "invalidate", "invalidate"];
          const history: string[] = [];
          while (actions.length) {
            const action = actions.splice(random() % actions.length, 1)[0];
            history.push(action);
            now += 150; // Permit the documented local-tag refresh interval to elapse.
            if (action === "invalidate") {
              invalidated = now;
              await workers[0].call({ op: "invalidate", tags: [tag], now });
              if (lane === "memory") await workers[1].call({ op: "invalidate", tags: [tag], now });
            } else {
              const index = Number(action.slice(-1));
              const request = `${key}-${index}`;
              if (action.startsWith("begin")) {
                const entry = { value: request, timestamp: now };
                pending.set(index, entry);
                await workers[index].call({
                  op: "begin",
                  kind,
                  key,
                  request,
                  tags: [tag],
                  now,
                  value: entry.value,
                });
                actions.push(`finish-${index}`);
              } else {
                await workers[index].call({ op: "finish", request, now });
                const entry = pending.get(index);
                if (!entry) throw new Error(`No pending render for seed ${seed}`);
                pending.delete(index);
                model[index] = entry;
                if (lane === "redis" && kind !== "local") model[1 - index] = entry;
              }
            }
            // get() waits for pending data writes; inspect each process once both writes complete.
            if (pending.size === 0) {
              now += 150;
              for (let index = 0; index < 2; index++) {
                const entry = model[index];
                const expected = entry && entry.timestamp >= invalidated ? entry.value : undefined;
                const actual = await workers[index].call({
                  op: "read",
                  kind,
                  key,
                  request: `read-${key}-${now}`,
                  now,
                });
                expect(
                  actual?.value,
                  `seed=${seed} lane=${lane} kind=${kind} process=${index} trace=${history.join(",")}`,
                ).toBe(expected);
              }
            }
          }
        }
      },
      120_000,
    );

    test.each(["page", "remote", "local"])(
      "%s: delayed invalidation serves stale only before its hard deadline",
      async (kind) => {
        const a = await start(lane);
        const b = await start(lane);
        for (const worker of [a, b]) {
          await worker.call({
            op: "begin",
            kind,
            key: "window",
            request: "old",
            tags: ["window"],
            value: "old",
            now: epoch,
          });
          await worker.call({ op: "finish", request: "old", now: epoch + 20 });
        }
        const invalidate = {
          op: "invalidate",
          tags: ["window"],
          durations: { expire: 2 },
          now: epoch + 100,
        };
        await a.call(invalidate);
        if (lane === "memory") await b.call(invalidate);
        for (const worker of [a, b]) {
          const read = { op: "read", kind, key: "window", request: "window-read" };
          expect((await worker.call({ ...read, now: epoch + 2099 }))?.value).toBe("old");
          expect(await worker.call({ ...read, now: epoch + 2100 })).toBeNull();
        }
      },
    );

    test("implicit path invalidation reaches a peer page read", async () => {
      const a = await start(lane);
      const b = await start(lane);
      await b.call({
        op: "begin",
        kind: "page",
        key: "path",
        request: "path-render",
        tags: [],
        value: "old",
        now: epoch,
      });
      await b.call({ op: "finish", request: "path-render", now: epoch + 20 });
      const read = {
        op: "read",
        kind: "page",
        key: "path",
        request: "path-read",
        context: { softTags: ["_N_T_/products"] },
      };
      expect((await b.call({ ...read, now: epoch + 30 }))?.value).toBe("old");
      const invalidate = { op: "invalidate", tags: ["_N_T_/products"], now: epoch + 100 };
      await a.call(invalidate);
      if (lane === "memory") await b.call(invalidate);
      expect(await b.call({ ...read, now: epoch + 200 })).toBeNull();
    });
    test.each(lane === "redis" ? ["remote", "local"] : ["page", "remote", "local"])(
      "%s: cache lifetime boundaries use render start",
      async (kind) => {
        const worker = await start(lane);
        await worker.call({
          op: "begin",
          kind,
          key: "life",
          request: "life-render",
          tags: [],
          value: "old",
          life: { stale: 1, revalidate: 2, expire: 3 },
          now: epoch,
        });
        await worker.call({ op: "finish", request: "life-render", now: epoch + 250 });
        const read = { op: "read", kind, key: "life", request: "life-read" };
        for (const offset of [999, 1000, 1999])
          expect((await worker.call({ ...read, now: epoch + offset }))?.value).toBe("old");
        for (const offset of [2000, 2999]) {
          const entry = await worker.call({ ...read, now: epoch + offset });
          if (kind === "local") expect(entry).toBeNull();
          else expect(entry?.value).toBe("old");
        }
        expect(await worker.call({ ...read, now: epoch + 3000 })).toBeNull();
      },
    );
    if (lane === "redis") {
      // Redis page TTL starts at write completion, so a slow render extends the hard lifetime.
      // The setup and its positive checks run as an ordinary test; only the known bug is
      // asserted under test.fails, against the stored TTL rather than a timed read.
      let renderMs: number | undefined;
      let storedTtlMs: number | undefined;
      test("page hard expiry setup: a slow render is stored and readable", async () => {
        const worker = await start(lane, { realtime: true });
        const begun = await worker.call({
          op: "begin",
          kind: "page",
          key: "real-life",
          request: "real-life",
          tags: [],
          value: "old",
          life: { revalidate: 2, expire: 2 },
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await worker.call({ op: "finish", request: "real-life" });
        renderMs = Date.now() - (begun?.timestamp ?? 0);
        const read = { op: "read", kind: "page", key: "real-life", request: "before-expiry" };
        expect((await worker.call(read))?.value).toBe("old");
        const ttls = await Promise.all(
          (await raw?.keys(`${prefix}*`))?.map((key) => raw?.pttl(key)) ?? [],
        );
        const expiring = ttls.filter((ttl): ttl is number => (ttl ?? 0) > 0);
        expect(expiring.length).toBeGreaterThan(0);
        storedTtlMs = Math.max(...expiring);
      });
      // If the setup test fails, it fails the suite on its own.
      test.fails("page hard expiry includes time spent rendering (real clocks)", () => {
        // 300ms covers the gap between finish and the PTTL read.
        expect(storedTtlMs).toBeLessThanOrEqual(2000 - (renderMs ?? 0) + 300);
      });
    }
  });
}
