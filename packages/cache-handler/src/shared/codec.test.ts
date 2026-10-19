import { describe, expect, test } from "vitest";
import { FORMAT_VERSION, decodeEntry, encodeEntry, encodeEntryString } from "./codec.js";

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

  test("decodes the base64 string a string-only client stores", () => {
    const encoded = encodeEntryString({ value: Buffer.from("via base64"), tags: ["a"] });
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);

    const decoded = decodeEntry<{ value: Buffer; tags: string[] }>(encoded);
    expect(decoded?.tags).toEqual(["a"]);
    expect(Buffer.from(decoded?.value ?? []).toString()).toBe("via base64");
  });

  test("decodes a Buffer holding base64 text", () => {
    const text = encodeEntryString({ value: Buffer.from("buffered base64") });
    const decoded = decodeEntry<{ value: Buffer }>(Buffer.from(text, "utf8"));
    expect(Buffer.from(decoded?.value ?? []).toString()).toBe("buffered base64");
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
});
