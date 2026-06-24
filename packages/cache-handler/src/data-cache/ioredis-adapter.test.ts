import { describe, expect, test } from "vitest";
import { createIoredisAdapter } from "./ioredis-adapter.js";

/**
 * Captures the exact arguments forwarded to the underlying ioredis client so
 * we can assert the node-redis -> ioredis translation, especially for SET TTLs.
 */
function createFakeIoredis() {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, result: unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  return {
    calls,
    client: {
      get: record("get", "value"),
      set: record("set", "OK"),
      del: record("del", 1),
      exists: record("exists", 1),
      ttl: record("ttl", 42),
      hget: record("hget", "field-value"),
      hset: record("hset", 1),
      hgetall: record("hgetall", { a: "1" }),
    },
  };
}

describe("createIoredisAdapter", () => {
  test("translates node-redis SET options { EX } to ioredis positional args", async () => {
    const { client, calls } = createFakeIoredis();
    const adapter = createIoredisAdapter(client);

    await adapter.set("key", "value", { EX: 60 });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: "set", args: ["key", "value", "EX", 60] });
  });

  test("issues a plain SET when no TTL options are provided", async () => {
    const { client, calls } = createFakeIoredis();
    const adapter = createIoredisAdapter(client);

    await adapter.set("key", "value");

    expect(calls[0]).toEqual({ method: "set", args: ["key", "value"] });
  });

  test("does not pass through unrecognized option objects to ioredis", async () => {
    const { client, calls } = createFakeIoredis();
    const adapter = createIoredisAdapter(client);

    // An object without a numeric EX must not be forwarded verbatim (that is
    // exactly what triggers ioredis "ERR syntax error").
    await adapter.set("key", "value", { NX: true } as unknown as { EX: number });

    expect(calls[0]).toEqual({ method: "set", args: ["key", "value"] });
  });

  test("maps camelCase hash methods to ioredis lowercase methods", async () => {
    const { client, calls } = createFakeIoredis();
    const adapter = createIoredisAdapter(client);

    await adapter.hGet("h", "f");
    await adapter.hSet("h", "f", "v");
    await adapter.hGetAll("h");

    expect(calls.map((c) => c.method)).toEqual(["hget", "hset", "hgetall"]);
    expect(calls[1].args).toEqual(["h", "f", "v"]);
  });

  test("delegates get/del/exists/ttl to the underlying client", async () => {
    const { client, calls } = createFakeIoredis();
    const adapter = createIoredisAdapter(client);

    expect(await adapter.get("k")).toBe("value");
    expect(await adapter.ttl("k")).toBe(42);
    await adapter.del("k1", "k2");
    await adapter.exists("k1", "k2");

    expect(calls.find((c) => c.method === "del")?.args).toEqual(["k1", "k2"]);
    expect(calls.find((c) => c.method === "exists")?.args).toEqual(["k1", "k2"]);
  });
});
