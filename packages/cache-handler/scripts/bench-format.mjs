// Compares the 16.5.0 storage formats with format v2 on the same entries: bytes stored per
// entry and set / get+decode time against a real Redis.
//
//   pnpm --filter @mrjasonroy/cache-components-cache-handler build
//   BENCH_REDIS_URL=redis://127.0.0.1:26479 node packages/cache-handler/scripts/bench-format.mjs
//
// Writes only under a random prefix and deletes it afterwards.
import { randomBytes, randomUUID } from "node:crypto";
import Redis from "ioredis";
import { decodeEntry, encodeEntry } from "../dist/shared/codec.js";

const url = process.env.BENCH_REDIS_URL ?? "redis://127.0.0.1:6379";
const rounds = Number(process.env.BENCH_ROUNDS ?? 200);
const redis = new Redis(url);
const prefix = `bench:${randomUUID()}:`;

// RSC-like text: JSON rows with some multi-byte characters, as a "use cache" entry holds.
function rscText(bytes) {
  const row = '1:["$","div",null,{"className":"card","children":["Datasheet – µA/°C ","$L2"]}]\n';
  return Buffer.from(row.repeat(Math.ceil(bytes / Buffer.byteLength(row)))).subarray(0, bytes);
}

// 16.5.0 "use cache" format: JSON with the value in base64.
const v1Data = {
  encode: (e) => JSON.stringify({ ...e, value: e.value.toString("base64") }),
  decode: (s) => {
    const o = JSON.parse(s);
    return { ...o, value: Buffer.from(o.value, "base64") };
  },
  read: (key) => redis.get(key),
};
// Page entries before v2 (the GS handler, and 16.4's RedisCacheHandler): JSON with Buffers in
// base64 and Maps as entry arrays.
function replacer(key, value) {
  const raw = this[key];
  if (raw instanceof Map) return { __serialized_type: "Map", entries: [...raw.entries()] };
  if (Buffer.isBuffer(raw)) return { __serialized_type: "Buffer", data: raw.toString("base64") };
  return value;
}
function reviver(_key, value) {
  if (value?.__serialized_type === "Map") return new Map(value.entries);
  if (value?.__serialized_type === "Buffer") return Buffer.from(value.data, "base64");
  return value;
}
const v1Page = {
  encode: (e) => JSON.stringify(e, replacer),
  decode: (s) => JSON.parse(s, reviver),
  read: (key) => redis.get(key),
};
const v2 = { encode: encodeEntry, decode: decodeEntry, read: (key) => redis.getBuffer(key) };

const meta = { tags: ["a", "b"], stale: 30, timestamp: Date.now(), expire: 3600, revalidate: 60 };
const page = (html, rsc, segments) => ({
  value: {
    kind: "APP_PAGE",
    html,
    rscData: rsc,
    segmentData: new Map(segments.map((s, i) => [`/seg${i}`, s])),
    headers: { "x-next-cache-tags": "a,b" },
    status: 200,
  },
  tags: ["a", "b"],
  lastModified: Date.now(),
  cacheControl: { revalidate: 60, expire: 3600 },
});

const cases = [
  ["use cache, 2 KB RSC text", { ...meta, value: rscText(2_048) }, v1Data],
  ["use cache, 64 KB RSC text", { ...meta, value: rscText(65_536) }, v1Data],
  ["use cache, 64 KB random bytes", { ...meta, value: randomBytes(65_536) }, v1Data],
  ["use cache, 1 MB RSC text", { ...meta, value: rscText(1_048_576) }, v1Data],
  [
    "page shell, 100 KB html + 60 KB rsc + 4×10 KB segments",
    page(
      rscText(102_400).toString(),
      rscText(61_440),
      [1, 2, 3, 4].map(() => rscText(10_240)),
    ),
    v1Page,
  ],
];

async function measure(format, entry, key) {
  const encoded = format.encode(entry);
  await redis.set(key, encoded);
  const bytes = await redis.strlen(key);
  let setMs = 0;
  let getMs = 0;
  for (let i = 0; i < rounds; i++) {
    let t = performance.now();
    await redis.set(key, format.encode(entry), "EX", 60);
    setMs += performance.now() - t;
    t = performance.now();
    const decoded = format.decode(await format.read(key));
    getMs += performance.now() - t;
    if (!decoded) throw new Error("decode failed");
  }
  return { bytes, set: setMs / rounds, get: getMs / rounds };
}

const rows = [];
for (const [name, entry, v1] of cases) {
  const old = await measure(v1, entry, `${prefix}v1`);
  const neu = await measure(v2, entry, `${prefix}v2`);
  rows.push({
    entry: name,
    "16.5 bytes": old.bytes,
    "v2 bytes": neu.bytes,
    "v2/16.5": (neu.bytes / old.bytes).toFixed(2),
    "16.5 set ms": old.set.toFixed(3),
    "v2 set ms": neu.set.toFixed(3),
    "16.5 get ms": old.get.toFixed(3),
    "v2 get ms": neu.get.toFixed(3),
  });
}
console.table(rows);
await redis.del(`${prefix}v1`, `${prefix}v2`);
await redis.quit();
