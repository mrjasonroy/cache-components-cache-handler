// Page-handler `get` latency against a real Redis: hits and misses with a typical page's tags
// (5 soft/implicit `_N_T_` tags from Next, 4 explicit tags in the entry header), plus the Redis
// commands and keys each get costs, from INFO commandstats.
//
//   pnpm --filter @mrjasonroy/cache-components-cache-handler build
//   BENCH_REDIS_URL=redis://127.0.0.1:6390 node packages/cache-handler/scripts/bench-page-get.mjs
//
// BENCH_DIST points at another build (e.g. a copy of dist/ from an earlier design) to compare.
// Writes only under a random prefix and deletes it afterwards.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Redis from "ioredis";

const url = process.env.BENCH_REDIS_URL ?? "redis://127.0.0.1:6379";
const rounds = Number(process.env.BENCH_ROUNDS ?? 3000);
const dist = resolve(process.env.BENCH_DIST ?? new URL("../dist", import.meta.url).pathname);
const { createRedisCacheHandler, flushCache } = await import(
  pathToFileURL(resolve(dist, "index.js")).href
);

const prefix = `bench:${randomUUID()}:`;
const raw = new Redis(url);
const Handler = createRedisCacheHandler({ url, keyPrefix: prefix, buildId: "bench" });
const handler = new Handler({});
// A second instance (its own connection and process state) that has never read the entries.
const ColdHandler = createRedisCacheHandler({
  url,
  keyPrefix: prefix,
  buildId: "bench",
  commandTimeout: 1001,
});
const cold = new ColdHandler({});
const COLD_ENTRIES = 1000;

const softTags = [
  "_N_T_/layout",
  "_N_T_/blog/layout",
  "_N_T_/blog/[slug]/layout",
  "_N_T_/blog/[slug]/page",
  "_N_T_/blog/post-1",
];
const explicitTags = ["posts", "post-1", "author-7", "nav"];
const ctx = { kind: "APP_PAGE", softTags, isFallback: false };

function page(i) {
  return {
    kind: "APP_PAGE",
    html: `<html>${"<p>datasheet row</p>".repeat(1000)}${i}</html>`,
    rscData: Buffer.alloc(20_000, 1),
    segmentData: new Map([["/_index", Buffer.alloc(2_000, 2)]]),
    headers: { "x-next-cache-tags": [...explicitTags, ...softTags].join(",") },
    status: 200,
  };
}

async function commandStats() {
  const info = await raw.info("commandstats");
  const stats = {};
  for (const line of info.split("\n")) {
    const match = /^cmdstat_(\w+):calls=(\d+)/.exec(line);
    if (match) stats[match[1]] = Number(match[2]);
  }
  return stats;
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function measure(label, keyOf, target = handler, count = rounds) {
  const before = await commandStats();
  const times = [];
  for (let i = 0; i < count; i++) {
    const started = process.hrtime.bigint();
    await target.get(keyOf(i), ctx);
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
    // ~1 ms between gets, so a phase spans several seconds, as a page's traffic does.
    await new Promise((r) => setTimeout(r, 1));
  }
  const after = await commandStats();
  times.sort((a, b) => a - b);
  const perGet = {};
  for (const [name, calls] of Object.entries(after)) {
    const delta = calls - (before[name] ?? 0);
    if (delta > 0 && name !== "info") perGet[name] = +(delta / count).toFixed(4);
  }
  console.log(
    `${label.padEnd(5)} p50 ${percentile(times, 50).toFixed(3)} ms  p99 ${percentile(times, 99).toFixed(3)} ms  commands/get ${JSON.stringify(perGet)}`,
  );
}

// Some tags have been revalidated before, as on a live site.
await handler.revalidateTag(["nav", "_N_T_/layout"]);
await new Promise((r) => setTimeout(r, 5));
for (let i = 0; i < 100; i++) {
  await handler.set(`/blog/post-${i}`, page(i), {
    cacheControl: { revalidate: 3600, expire: 86_400 },
  });
}

for (let i = 0; i < COLD_ENTRIES; i++) {
  await handler.set(`/cold/${i}`, page(i), { cacheControl: { revalidate: 3600, expire: 86_400 } });
}

// Warm up the connections and the JIT.
for (let i = 0; i < 300; i++) {
  await handler.get(`/blog/post-${i % 100}`, ctx);
  await cold.get(`/missing-warmup-${i}`, ctx);
}

console.log(`dist: ${dist}  rounds: ${rounds}`);
await measure("hit", (i) => `/blog/post-${i % 100}`);
await measure("miss", (i) => `/missing-${i}`);
// First read of each entry by an instance that did not write it.
await measure("cold", (i) => `/cold/${i}`, cold, COLD_ENTRIES);

await flushCache({ url, keyPrefix: prefix, scope: "all" });
raw.disconnect();
process.exit(0);
