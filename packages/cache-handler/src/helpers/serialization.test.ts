import { describe, expect, test } from "vitest";
import { jsonReplacer, jsonReviver } from "./serialization.js";

/**
 * Serialize and deserialize a value the same way the cache handlers do, so the
 * tests exercise the replacer/reviver pair as an end-to-end round trip.
 */
function roundTrip<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, jsonReplacer), jsonReviver);
}

describe("serialization helpers", () => {
  describe("Map", () => {
    test("round-trips a Map preserving entries and order", () => {
      const map = new Map<string, number>([
        ["a", 1],
        ["b", 2],
      ]);

      const result = roundTrip(map);

      expect(result).toBeInstanceOf(Map);
      expect([...(result as Map<string, number>)]).toEqual([
        ["a", 1],
        ["b", 2],
      ]);
    });

    test("round-trips an empty Map", () => {
      const result = roundTrip(new Map());
      expect(result).toBeInstanceOf(Map);
      expect((result as Map<unknown, unknown>).size).toBe(0);
    });

    test("round-trips a Map nested inside an object", () => {
      const value = { segmentData: new Map([["/page", "data"]]) };
      const result = roundTrip(value) as { segmentData: Map<string, string> };

      expect(result.segmentData).toBeInstanceOf(Map);
      expect(result.segmentData.get("/page")).toBe("data");
    });
  });

  describe("Buffer", () => {
    test("round-trips a Buffer preserving bytes", () => {
      const buf = Buffer.from("hello world", "utf-8");
      const result = roundTrip(buf);

      expect(Buffer.isBuffer(result)).toBe(true);
      expect((result as Buffer).toString("utf-8")).toBe("hello world");
    });

    test("round-trips binary (non-UTF8) bytes", () => {
      const buf = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f]);
      const result = roundTrip(buf) as Buffer;

      expect(Buffer.isBuffer(result)).toBe(true);
      expect([...result]).toEqual([0x00, 0xff, 0x10, 0x80, 0x7f]);
    });

    test("round-trips an empty Buffer", () => {
      const result = roundTrip(Buffer.alloc(0));
      expect(Buffer.isBuffer(result)).toBe(true);
      expect((result as Buffer).length).toBe(0);
    });
  });

  describe("nested Buffer (Node toJSON before replacer)", () => {
    test("serializes rscData as base64, not int-array JSON", () => {
      const entry = { rscData: Buffer.from('1:"test"') };
      const serialized = JSON.stringify(entry, jsonReplacer);

      expect(serialized).toContain('"__serialized_type":"Buffer"');
      expect(serialized).toContain('"data":"MToidGVzdCI="');
      expect(serialized).not.toContain('"type":"Buffer"');
      expect(serialized).not.toMatch(/"data":\[\d+,/);
    });

    test("round-trips rscData nested in an APP_PAGE-like object", () => {
      const entry = {
        kind: "APP_PAGE",
        rscData: Buffer.from("page-rsc-payload"),
        html: "<html></html>",
      };
      const result = roundTrip(entry) as typeof entry;

      expect(Buffer.isBuffer(result.rscData)).toBe(true);
      expect(result.rscData.toString()).toBe("page-rsc-payload");
      expect(result.kind).toBe("APP_PAGE");
      expect(result.html).toBe("<html></html>");
    });
  });

  describe("Next.js APP_PAGE shape (Map<string, Buffer>)", () => {
    test("round-trips a Map of Buffers (segmentData)", () => {
      const segmentData = new Map<string, Buffer>([
        ["/layout", Buffer.from("layout-rsc")],
        ["/page", Buffer.from("page-rsc")],
      ]);

      const result = roundTrip(segmentData) as Map<string, Buffer>;

      expect(result).toBeInstanceOf(Map);
      expect(Buffer.isBuffer(result.get("/layout"))).toBe(true);
      expect(result.get("/layout")?.toString()).toBe("layout-rsc");
      expect(result.get("/page")?.toString()).toBe("page-rsc");
    });
  });

  describe("backward compatibility", () => {
    test("revives Node's native Buffer.toJSON() representation", () => {
      // What `JSON.stringify(buffer)` produces without the custom replacer.
      const native = { type: "Buffer", data: [104, 105] }; // "hi"
      const result = JSON.parse(JSON.stringify(native), jsonReviver);

      expect(Buffer.isBuffer(result)).toBe(true);
      expect((result as Buffer).toString()).toBe("hi");
    });
  });

  describe("guards against false positives", () => {
    test("does not convert user data shaped like a serialized Buffer", () => {
      // `data` is a string, not base64 marker — must stay a plain object.
      const userValue = { __serialized_type: "Buffer" };
      const result = roundTrip(userValue);
      expect(result).toEqual(userValue);
    });

    test("does not convert { type: 'Buffer' } with non-numeric data", () => {
      const userValue = { type: "Buffer", data: ["not", "bytes"] };
      const result = roundTrip(userValue);
      expect(Buffer.isBuffer(result)).toBe(false);
      expect(result).toEqual(userValue);
    });

    test("does not convert { type: 'Buffer' } with invalid byte values", () => {
      const userValue = { type: "Buffer", data: [1, 256, 3.5] };
      const result = roundTrip(userValue);
      expect(Buffer.isBuffer(result)).toBe(false);
      expect(result).toEqual(userValue);
    });

    test("does not convert a fake Map marker with malformed entries", () => {
      const userValue = { __serialized_type: "Map", entries: "not-an-array" };
      const result = roundTrip(userValue);
      expect(result).not.toBeInstanceOf(Map);
      expect(result).toEqual(userValue);
    });
  });

  describe("plain values pass through untouched", () => {
    test("leaves primitives, arrays, and plain objects unchanged", () => {
      const value = {
        n: 42,
        s: "text",
        b: true,
        nil: null,
        arr: [1, "two", false],
        nested: { x: { y: "z" } },
      };
      expect(roundTrip(value)).toEqual(value);
    });
  });
});
