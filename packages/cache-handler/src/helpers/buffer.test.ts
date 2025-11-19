import { describe, expect, test } from "vitest";
import { bufferToString, stringToBuffer } from "./buffer.js";

describe("buffer helpers", () => {
  test("bufferToString converts buffers to base64 strings", () => {
    const buffer = Buffer.from("hello");

    expect(bufferToString(buffer)).toBe(buffer.toString("base64"));
  });

  test("bufferToString recursively converts buffers inside objects and arrays", () => {
    const nested = {
      body: Buffer.from("test-body"),
      meta: {
        tags: ["static", Buffer.from("dynamic")],
      },
      list: [Buffer.from("a"), Buffer.from("b")],
    };

    const result = bufferToString(nested) as typeof nested;

    expect(result.body).toBe(Buffer.from("test-body").toString("base64"));
    expect(result.meta).toEqual({
      tags: ["static", Buffer.from("dynamic").toString("base64")],
    });
    expect(result.list).toEqual([
      Buffer.from("a").toString("base64"),
      Buffer.from("b").toString("base64"),
    ]);
  });

  test("stringToBuffer converts base64 back to Buffer when flagged", () => {
    const original = Buffer.from("cached-response");
    const encoded = original.toString("base64");

    const decoded = stringToBuffer(encoded, true);
    expect(decoded).toBeInstanceOf(Buffer);
    expect((decoded as Buffer).toString()).toBe("cached-response");

    expect(stringToBuffer(encoded, false)).toBe(encoded);
  });
});
