import { randomBytes } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { describe, expect, test, vi } from "vitest";
import {
  COMPRESSED_FORMAT_VERSION,
  COMPRESSION_THRESHOLD_BYTES,
  FORMAT_VERSION,
  decodeEntry,
  decodeStored,
  encodeEntry,
  encodeStored,
  storedSizes,
} from "./codec.js";

const PREAMBLE_LENGTH = 8;

function headerLength(encoded: Buffer): number {
  return encoded.readUInt32BE(4);
}

describe("entry codec", () => {
  test("round-trips nested Buffers, a Map of Buffers and unicode strings", () => {
    const value = {
      title: "Grüße, 世界 🚀",
      nested: { body: Buffer.from("héllo"), list: [Buffer.from([0, 1, 2, 255]), "plain", 42] },
      segments: new Map<string, Buffer>([
        ["/a", Buffer.from("segment a")],
        ["/ü", Buffer.from([9, 8, 7])],
      ]),
      empty: Buffer.alloc(0),
      bytes: new Uint8Array([10, 20, 30]),
      flag: true,
      nothing: null,
    };

    const decoded = decodeEntry<{
      title: string;
      nested: { body: Buffer; list: [Buffer, string, number] };
      segments: Map<string, Buffer>;
      empty: Buffer;
      bytes: Buffer;
      flag: boolean;
      nothing: null;
    }>(encodeEntry(value));

    if (!decoded) {
      throw new Error("expected the entry to decode");
    }
    expect(decoded.title).toBe("Grüße, 世界 🚀");
    expect(Buffer.from(decoded.nested.body).toString()).toBe("héllo");
    expect(Buffer.from(decoded.nested.list[0])).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(decoded.nested.list.slice(1)).toEqual(["plain", 42]);
    expect(decoded.segments).toBeInstanceOf(Map);
    expect([...decoded.segments.keys()]).toEqual(["/a", "/ü"]);
    expect(Buffer.from(decoded.segments.get("/a") ?? []).toString()).toBe("segment a");
    expect(Buffer.from(decoded.segments.get("/ü") ?? [])).toEqual(Buffer.from([9, 8, 7]));
    expect(decoded.empty.length).toBe(0);
    expect(Buffer.from(decoded.bytes)).toEqual(Buffer.from([10, 20, 30]));
    expect(decoded.flag).toBe(true);
    expect(decoded.nothing).toBeNull();
  });

  test("starts with the magic and the format version", () => {
    const encoded = encodeEntry({ a: 1 });
    expect(encoded.subarray(0, 3).toString("latin1")).toBe("NCH");
    expect(encoded[3]).toBe(FORMAT_VERSION);
    expect(FORMAT_VERSION).toBe(2);
  });

  test("stores bytes raw: the size is the header plus the bytes, with no base64", () => {
    const payload = Buffer.alloc(64 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) % 256;

    const encoded = encodeEntry({ value: payload, tags: ["t"] });

    expect(encoded.length).toBe(PREAMBLE_LENGTH + headerLength(encoded) + payload.length);
    // The header only holds a reference to the bytes, so it stays small.
    expect(headerLength(encoded)).toBeLessThan(100);
    expect(encoded.subarray(encoded.length - payload.length)).toEqual(payload);
    // base64 would be 4/3 the size.
    expect(encoded.length).toBeLessThan(payload.length * 1.01);
  });

  test("rejects another magic", () => {
    const encoded = encodeEntry({ a: 1 });
    encoded[0] = "X".charCodeAt(0);
    expect(decodeEntry(encoded)).toBeUndefined();
  });

  test("rejects another format version", () => {
    for (const version of [1, 3, 255]) {
      const encoded = encodeEntry({ a: 1 });
      encoded[3] = version;
      expect(decodeEntry(encoded)).toBeUndefined();
    }
  });

  test("rejects truncated input", () => {
    const encoded = encodeEntry({ value: Buffer.from("some bytes"), tags: [] });
    // Truncated blob section.
    expect(decodeEntry(encoded.subarray(0, encoded.length - 1))).toBeUndefined();
    // Truncated header.
    expect(decodeEntry(encoded.subarray(0, PREAMBLE_LENGTH + 2))).toBeUndefined();
    // Truncated preamble.
    expect(decodeEntry(encoded.subarray(0, 5))).toBeUndefined();
  });

  test("rejects JSON input, as 16.5.0 stored it", () => {
    const legacy = JSON.stringify({
      value: Buffer.from("old").toString("base64"),
      tags: [],
      stale: 0,
      timestamp: 1,
      expire: 60,
      revalidate: 30,
    });
    expect(decodeEntry(legacy)).toBeUndefined();
    expect(decodeEntry(Buffer.from(legacy))).toBeUndefined();
    expect(decodeEntry("")).toBeUndefined();
    expect(decodeEntry(null)).toBeUndefined();
    expect(decodeEntry(undefined)).toBeUndefined();
  });

  test("base64 text of an entry is a miss: every client stores the bytes", async () => {
    const encoded = encodeEntry({ value: Buffer.from("via base64"), tags: ["a"] });
    const text = encoded.toString("base64");
    expect(decodeEntry(text)).toBeUndefined();
    expect(decodeEntry(Buffer.from(text, "utf8"))).toBeUndefined();
    expect(await decodeStored(text)).toBeUndefined();
  });

  test("decodes binary handed back as a latin1 string", () => {
    const encoded = encodeEntry({ value: Buffer.from([0, 200, 255]) });
    const decoded = decodeEntry<{ value: Buffer }>(encoded.toString("latin1"));
    expect(Buffer.from(decoded?.value ?? [])).toEqual(Buffer.from([0, 200, 255]));
  });
  describe("bytes repeated within an entry are stored once", () => {
    function flight(size: number, seed = 1): Buffer {
      const bytes = Buffer.alloc(size);
      for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed * 7) % 256;
      return bytes;
    }

    /** An APP_PAGE value as Next 16 writes it, with `segmentData['/_full']` given. */
    function page(rscData: Buffer, full: Buffer) {
      return {
        kind: "APP_PAGE",
        html: "<html>shell</html>",
        headers: { "x-next-cache-tags": "a,b" },
        rscData,
        postponed: "{}",
        status: 200,
        segmentData: new Map<string, Buffer>([
          ["/_tree", flight(300, 2)],
          ["/_full", full],
          ["/parts/__PAGE__", flight(2_000, 3)],
        ]),
      };
    }

    function decodePage(encoded: Buffer) {
      return decodeEntry<{ rscData: Buffer; segmentData: Map<string, Buffer>; html: string }>(
        encoded,
      );
    }

    /** What a plain encoding costs beyond its header: the sum of every blob. */
    function blobBytes(encoded: Buffer): number {
      return encoded.length - PREAMBLE_LENGTH - headerLength(encoded);
    }

    test("Cache Components: rscData is a marker byte plus /_full, stored once, decoded exactly", () => {
      const full = flight(10_000);
      const rscData = Buffer.concat([Buffer.from([0x23]), full]);
      const value = page(rscData, full);

      const encoded = encodeEntry(value);
      const decoded = decodePage(encoded);

      expect(Buffer.compare(decoded?.rscData ?? Buffer.alloc(0), rscData)).toBe(0);
      for (const [path, bytes] of value.segmentData) {
        expect(Buffer.compare(decoded?.segmentData.get(path) ?? Buffer.alloc(0), bytes)).toBe(0);
      }
      expect(decoded?.html).toBe("<html>shell</html>");
      // rscData, /_tree and __PAGE__; /_full is a view into rscData.
      expect(blobBytes(encoded)).toBe(rscData.length + 300 + 2_000);
    });

    test("legacy: rscData and /_full are the same bytes, stored once", () => {
      const rscData = flight(10_000);
      for (const full of [rscData, Buffer.from(rscData)]) {
        const encoded = encodeEntry(page(rscData, full));
        const decoded = decodePage(encoded);

        expect(Buffer.compare(decoded?.segmentData.get("/_full") ?? Buffer.alloc(0), rscData)).toBe(
          0,
        );
        expect(Buffer.compare(decoded?.rscData ?? Buffer.alloc(0), rscData)).toBe(0);
        expect(blobBytes(encoded)).toBe(10_000 + 300 + 2_000);
      }
    });

    test("in either order: a /_full met before rscData is still stored once", () => {
      const full = flight(10_000);
      const rscData = Buffer.concat([Buffer.from([0x7e]), full]);
      const { rscData: _rsc, ...rest } = page(rscData, full);
      const value = { segmentData: rest.segmentData, ...rest, rscData };

      const encoded = encodeEntry(value);
      const decoded = decodePage(encoded);

      expect(Buffer.compare(decoded?.rscData ?? Buffer.alloc(0), rscData)).toBe(0);
      expect(Buffer.compare(decoded?.segmentData.get("/_full") ?? Buffer.alloc(0), full)).toBe(0);
      expect(blobBytes(encoded)).toBe(rscData.length + 300 + 2_000);
    });

    test("bytes that differ are each stored", () => {
      const rscData = flight(10_000);
      const oneByteOff = Buffer.from(rscData);
      oneByteOff[5_000] ^= 1;
      const cases: [string, Buffer][] = [
        // Same length, one byte different.
        ["same length", oneByteOff],
        // One byte shorter, but the prefix, not the suffix.
        ["prefix", rscData.subarray(0, rscData.length - 1)],
        // One byte shorter suffix of different bytes.
        ["other suffix", oneByteOff.subarray(1)],
        // Two bytes shorter suffix: only a one-byte marker is shared.
        ["two-byte suffix", rscData.subarray(2)],
      ];
      for (const [name, full] of cases) {
        const encoded = encodeEntry(page(rscData, full));
        const decoded = decodePage(encoded);

        expect(blobBytes(encoded), name).toBe(10_000 + full.length + 300 + 2_000);
        expect(Buffer.compare(decoded?.segmentData.get("/_full") ?? Buffer.alloc(0), full)).toBe(0);
        expect(Buffer.compare(decoded?.rscData ?? Buffer.alloc(0), rscData)).toBe(0);
      }
    });

    test("a page entry shrinks by the size of /_full, and decodes with the plain v2 reader", () => {
      const full = flight(50_000);
      const rscData = Buffer.concat([Buffer.from([0x23]), full]);
      const deduped = encodeEntry(page(rscData, full));
      // The same entry with /_full made different, so it cannot be shared.
      const distinct = Buffer.from(full);
      distinct[0] ^= 1;
      const plain = encodeEntry(page(rscData, distinct));

      expect(blobBytes(plain) - blobBytes(deduped)).toBe(full.length);
      // The header differs only in the digits of one offset.
      expect(Math.abs(headerLength(plain) - headerLength(deduped))).toBeLessThan(10);
      expect(deduped[3]).toBe(FORMAT_VERSION);
    });
  });

  describe("compressed entries (format v3)", () => {
    /** Text-like bytes that compress well, as page HTML and flight data do. */
    function text(size: number, seed = 1): Buffer {
      const words = ["valve", "sensor", "pressure", "stainless", "actuator", "flow", "meter"];
      let out = "";
      for (let i = 0; out.length < size; i++)
        out += `${words[(i * 7 + seed) % words.length]}-${i % 97} `;
      return Buffer.from(out.slice(0, size));
    }

    const on = {};
    const off = { CACHE_COMPRESSION: "off" };
    const COMPRESSED_PREAMBLE_LENGTH = 9;

    test("above the threshold: stored as v3 brotli, decoded to the same value", async () => {
      const value = { value: text(64 * 1024), tags: ["a"], html: "x".repeat(1000) };
      const stored = await encodeStored(value, on);

      expect(stored.subarray(0, 3).toString("latin1")).toBe("NCH");
      expect(stored[3]).toBe(COMPRESSED_FORMAT_VERSION);
      expect(stored[4]).toBe(1);
      const v2 = encodeEntry(value);
      expect(stored.readUInt32BE(5)).toBe(v2.length);
      expect(brotliDecompressSync(stored.subarray(COMPRESSED_PREAMBLE_LENGTH))).toEqual(v2);
      expect(stored.length).toBeLessThan(v2.length / 4);
      expect(storedSizes(stored)).toEqual({ bytes: v2.length, encodedBytes: stored.length });

      const decoded = await decodeStored<typeof value>(stored);
      expect(Buffer.compare(decoded?.value ?? Buffer.alloc(0), value.value)).toBe(0);
      expect(decoded?.tags).toEqual(["a"]);
      expect(decoded?.html).toBe(value.html);
    });

    test("below the threshold: stored as plain v2", async () => {
      const value = { value: text(COMPRESSION_THRESHOLD_BYTES - 200), tags: [] };
      const stored = await encodeStored(value, on);

      expect(stored).toEqual(encodeEntry(value));
      expect(storedSizes(stored)).toEqual({ bytes: stored.length, encodedBytes: stored.length });
      const decoded = await decodeStored<typeof value>(stored);
      expect(Buffer.compare(decoded?.value ?? Buffer.alloc(0), value.value)).toBe(0);
    });

    test("the threshold is 16 KB of encoded v2 entry", async () => {
      expect(COMPRESSION_THRESHOLD_BYTES).toBe(16 * 1024);
      const at = { value: text(COMPRESSION_THRESHOLD_BYTES) };
      expect((await encodeStored(at, on))[3]).toBe(COMPRESSED_FORMAT_VERSION);
    });

    test("bytes that do not compress are stored as v2", async () => {
      const random = randomBytes(64 * 1024);
      const stored = await encodeStored({ value: random }, on);
      expect(stored[3]).toBe(FORMAT_VERSION);
    });

    test("CACHE_COMPRESSION=off (also 0, false) writes v2", async () => {
      const value = { value: text(64 * 1024) };
      for (const setting of ["off", "0", "false", "OFF"]) {
        const stored = await encodeStored(value, { CACHE_COMPRESSION: setting });
        expect(stored, setting).toEqual(encodeEntry(value));
      }
      // The reader still reads both.
      expect(await decodeStored(await encodeStored(value, on))).toBeDefined();
      expect(await decodeStored(await encodeStored(value, off))).toBeDefined();
    });

    test("v2 entries, binary or latin1 text, still decode", async () => {
      const value = { value: Buffer.from("plain v2"), tags: ["t"] };
      for (const raw of [encodeEntry(value), encodeEntry(value).toString("latin1")]) {
        const decoded = await decodeStored<typeof value>(raw);
        expect(Buffer.from(decoded?.value ?? []).toString()).toBe("plain v2");
      }
      expect(await decodeStored(null)).toBeUndefined();
      expect(await decodeStored(undefined)).toBeUndefined();
      expect(await decodeStored("")).toBeUndefined();
    });

    test("a v3 entry handed back as latin1 text decodes", async () => {
      const value = { value: text(64 * 1024) };
      const stored = await encodeStored(value, on);
      const decoded = await decodeStored<typeof value>(stored.toString("latin1"));
      expect(Buffer.compare(decoded?.value ?? Buffer.alloc(0), value.value)).toBe(0);
    });

    test("the synchronous v2 reader treats v3 as a miss", async () => {
      expect(decodeEntry(await encodeStored({ value: text(64 * 1024) }, on))).toBeUndefined();
    });

    test("a corrupt, truncated or mislabelled v3 entry is a miss, never a throw", async () => {
      const stored = await encodeStored({ value: text(64 * 1024) }, on);

      const truncated = [
        stored.subarray(0, stored.length - 10),
        stored.subarray(0, COMPRESSED_PREAMBLE_LENGTH + 5),
        stored.subarray(0, COMPRESSED_PREAMBLE_LENGTH),
        stored.subarray(0, 6),
      ];
      for (const raw of truncated) await expect(decodeStored(raw)).resolves.toBeUndefined();

      const flipped = Buffer.from(stored);
      for (let i = COMPRESSED_PREAMBLE_LENGTH; i < flipped.length; i += 7) flipped[i] ^= 0xa5;
      await expect(decodeStored(flipped)).resolves.toBeUndefined();

      // The stored length is wrong, either way.
      for (const delta of [-1, 1]) {
        const wrongLength = Buffer.from(stored);
        wrongLength.writeUInt32BE(stored.readUInt32BE(5) + delta, 5);
        await expect(decodeStored(wrongLength)).resolves.toBeUndefined();
      }

      // A compressed payload that is not a v2 entry.
      const notV2 = Buffer.from(stored.subarray(0, COMPRESSED_PREAMBLE_LENGTH));
      const payload = brotliCompressSync(Buffer.from("not an entry at all"));
      notV2.writeUInt32BE(19, 5);
      await expect(decodeStored(Buffer.concat([notV2, payload]))).resolves.toBeUndefined();
    });

    test("a v3 entry stating more than 64 MB is a miss, without decompressing it", async () => {
      const zlib = process.getBuiltinModule("node:zlib") as typeof import("node:zlib");
      const decompress = vi.spyOn(zlib, "brotliDecompress");
      try {
        const stored = await encodeStored({ value: text(64 * 1024) }, on);
        const oversized = Buffer.from(stored);
        oversized.writeUInt32BE(64 * 1024 * 1024 + 1, 5);
        await expect(decodeStored(oversized)).resolves.toBeUndefined();
        expect(decompress).not.toHaveBeenCalled();
      } finally {
        decompress.mockRestore();
      }
    });

    test("an entry over 64 MB is stored as v2, so no stored v3 entry is over the cap", async () => {
      const zlib = process.getBuiltinModule("node:zlib") as typeof import("node:zlib");
      const compress = vi.spyOn(zlib, "brotliCompress");
      try {
        const stored = await encodeStored({ value: Buffer.alloc(64 * 1024 * 1024) }, on);
        expect(stored[3]).toBe(FORMAT_VERSION);
        expect(compress).not.toHaveBeenCalled();
      } finally {
        compress.mockRestore();
      }
    });

    test("an unknown codec byte is a miss", async () => {
      const stored = await encodeStored({ value: text(64 * 1024) }, on);
      for (const codec of [0, 2, 3, 255]) {
        const other = Buffer.from(stored);
        other[4] = codec;
        await expect(decodeStored(other), String(codec)).resolves.toBeUndefined();
      }
    });

    test("the /_full dedup survives compression", async () => {
      const full = text(40_000, 3);
      const rscData = Buffer.concat([Buffer.from([0x23]), full]);
      const value = {
        kind: "APP_PAGE",
        html: "<html></html>",
        rscData,
        segmentData: new Map<string, Buffer>([["/_full", full]]),
      };
      const stored = await encodeStored(value, on);

      expect(stored[3]).toBe(COMPRESSED_FORMAT_VERSION);
      const inner = brotliDecompressSync(stored.subarray(COMPRESSED_PREAMBLE_LENGTH));
      expect(inner).toEqual(encodeEntry(value));
      // One copy of the flight data, not two.
      expect(inner.length - PREAMBLE_LENGTH - headerLength(inner)).toBe(rscData.length);

      const decoded = await decodeStored<typeof value>(stored);
      expect(Buffer.compare(decoded?.rscData ?? Buffer.alloc(0), rscData)).toBe(0);
      expect(Buffer.compare(decoded?.segmentData.get("/_full") ?? Buffer.alloc(0), full)).toBe(0);
    });

    test("a DS-shaped ~200 KB page entry is stored in a fraction of its size", async () => {
      const value = dsPage();
      const v2 = encodeEntry(value);
      const stored = await encodeStored(value, on);

      // ~190 KB of parts; /_full is stored once, so v2 is ~140 KB.
      expect(v2.length).toBeGreaterThan(130 * 1024);
      expect(v2.length).toBeLessThan(150 * 1024);
      expect(stored[3]).toBe(COMPRESSED_FORMAT_VERSION);
      // Brotli-4 takes it under 30 KB (the study: 14 KB on generated listings, ~half that ratio on
      // real output).
      expect(stored.length).toBeLessThan(30 * 1024);

      const decoded = await decodeStored<ReturnType<typeof dsPage>>(stored);
      expect(decoded?.html).toBe(value.html);
      expect(decoded?.postponed).toBe(value.postponed);
      expect(Buffer.compare(decoded?.rscData ?? Buffer.alloc(0), value.rscData)).toBe(0);
      for (const [path, bytes] of value.segmentData) {
        expect(Buffer.compare(decoded?.segmentData.get(path) ?? Buffer.alloc(0), bytes)).toBe(0);
      }
    });
  });
});

/**
 * An APP_PAGE value in the proportions of the DS site's entries (drafts/gn16-18-large-values.md):
 * html ~20 KB, `rscData` ~50 KB (a `#` marker plus the flight data), ~108 KB of segments in 7,
 * one of them `/_full`, and ~10 KB of `postponed`.
 */
function dsPage() {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)] as T;
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
  const adjectives = ["Industrial", "Compact", "High-Precision", "Stainless", "Sealed", "Rugged"];
  const nouns = ["Pressure Transducer", "Ball Valve", "Linear Actuator", "Flow Meter", "Load Cell"];
  const vendors = ["Acme Controls", "Bürkert", "Parker Hannifin", "Omega Engineering", "Festo"];
  const specs = ["Max Pressure", "Operating Temp", "Accuracy", "Output", "Voltage", "IP Rating"];
  const products = Array.from({ length: 450 }, (_, i) => {
    const name = `${pick(adjectives)} ${pick(nouns)} ${Math.floor(rand() * 9000 + 1000)}`;
    return {
      id: `${hex(8)}-${i}`,
      name,
      vendor: pick(vendors),
      img: `/_next/image?url=%2Fimages%2F${hex(16)}.jpg&w=256&q=75`,
      price: (rand() * 4000 + 10).toFixed(2),
      specs: Array.from({ length: 4 }, () => [pick(specs), (rand() * 500).toFixed(1)]),
    };
  });
  const flightRow = (p: (typeof products)[number], key: string) =>
    `["$","li","${key}${p.id}",{"children":[["$","a",null,{"href":"/product/${p.id}","children":[["$","$L1a",null,{"src":"${p.img}","alt":"${p.name}"}],["$","h3",null,{"children":"${p.name}"}]]}],["$","p",null,{"children":["by ","${p.vendor}"]}],["$","dl",null,{"children":[${p.specs.map(([a, b]) => `["$","dt",null,{"children":"${a}"}],["$","dd",null,{"children":"${b}"}]`).join(",")}]}],["$","span",null,{"children":"$$${p.price}"}]]}]`;
  const rows = (key: string, bytes: number, from = 0) => {
    const out: string[] = [];
    let size = 0;
    for (const p of products.slice(from)) {
      if (size >= bytes) break;
      const row = flightRow(p, key);
      out.push(row);
      size += row.length + 1;
    }
    return out.join(",");
  };
  const nav = (bytes: number, key: string) => {
    const items: string[] = [];
    for (let i = 0, size = 0; size < bytes; i++) {
      const item = `["$","li","${key}${i}",{"children":["$","a",null,{"href":"/category/${i}","children":"${pick(adjectives)} ${pick(nouns)}s"}]}]`;
      items.push(item);
      size += item.length + 1;
    }
    return Buffer.from(`0:{"rsc":["$","nav",null,{"children":[${items.join(",")}]}]}\n`);
  };
  const KB = 1024;
  const flight = Buffer.from(
    `0:{"buildId":"${hex(20)}"}\n18:["$","ul",null,{"children":[${rows("r", 50 * KB)}]}]\n`,
  );
  const html = `<!DOCTYPE html><html><head><title>Parts</title></head><body><main><ul>${products
    .slice(0, 60)
    .map(
      (p) =>
        `<li><a href="/product/${p.id}"><img alt="${p.name}" src="${p.img}"/><h3>${p.name}</h3></a><p>by ${p.vendor}</p><span>$${p.price}</span></li>`,
    )
    .join("")}</ul></main></body></html>`.slice(0, 20 * KB);
  return {
    kind: "APP_PAGE",
    html,
    rscData: Buffer.concat([Buffer.from([0x23]), flight]),
    headers: { "x-next-cache-tags": "_N_T_/layout,_N_T_/parts/layout,_N_T_/parts/[slug]/page" },
    postponed: JSON.stringify({ type: 2, data: [1, hex(12)], resume: rows("q", 10 * KB, 100) }),
    status: 200,
    segmentData: new Map<string, Buffer>([
      ["/_tree", nav(1 * KB, "t")],
      ["/_full", flight],
      ["/", nav(6 * KB, "n")],
      ["/parts", nav(5 * KB, "c")],
      ["/parts/[slug]", nav(4 * KB, "s")],
      ["/parts/[slug]/__PAGE__", Buffer.from(`0:{"rsc":[${rows("p", 38 * KB)}]}\n`)],
      ["/parts/[slug]/@related/__PAGE__", Buffer.from(`0:{"rsc":[${rows("x", 3 * KB, 200)}]}\n`)],
    ]),
  };
}
