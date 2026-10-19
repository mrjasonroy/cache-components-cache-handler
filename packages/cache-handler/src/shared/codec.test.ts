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
});
