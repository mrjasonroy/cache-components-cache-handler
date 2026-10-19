import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Turbopack's edge build fails when a Node built-in is LOADED (`Failed to load external module
 * node:module: TypeError: Native module not found`), at import time, not when it is called. So
 * importing any of these fails here too: the entries must not reach one, statically or otherwise,
 * until a handler needs it (never, on the edge runtime).
 */
vi.mock("node:module", () => {
  throw new Error("Native module not found: node:module");
});
vi.mock("node:fs", () => {
  throw new Error("Native module not found: node:fs");
});
vi.mock("node:path", () => {
  throw new Error("Native module not found: node:path");
});
vi.mock("node:url", () => {
  throw new Error("Native module not found: node:url");
});
vi.mock("node:crypto", () => {
  throw new Error("Native module not found: node:crypto");
});
vi.mock("node:os", () => {
  throw new Error("Native module not found: node:os");
});
vi.mock("ioredis", () => {
  throw new Error("Native module not found: ioredis");
});

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("handler entries on the edge runtime (Next bundles the page handler into middleware)", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_RUNTIME = "edge";
    process.env.REDIS_URL = "redis://localhost:6379";
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, "NEXT_RUNTIME");
    Reflect.deleteProperty(process.env, "REDIS_URL");
  });

  test("importing the page, remote and default entries loads no Node built-in", async () => {
    await expect(import("./page.js")).resolves.toBeDefined();
    await expect(import("./remote.js")).resolves.toBeDefined();
    await expect(import("./default.js")).resolves.toBeDefined();
  });

  test("the page handler is a no-op: every read a miss, writes and revalidations do nothing", async () => {
    const PageHandler = (await import("./page.js")).default;
    const handler = new PageHandler({ serverDistDir: "/app/.next/server", fs: {} });

    await handler.set(
      "/blog",
      { kind: "APP_PAGE", html: "x", headers: {} },
      { cacheControl: { revalidate: 60 } },
    );
    expect(await handler.get("/blog", { kind: "APP_PAGE" })).toBeNull();
    await expect(handler.revalidateTag("products")).resolves.toBeUndefined();
    await expect(handler.delete("/blog")).resolves.toBeUndefined();
  });

  test("the data handlers are no-ops that still release the entry's stream", async () => {
    for (const entryModule of ["./remote.js", "./default.js"] as const) {
      const handler = (await import(entryModule)).default;
      const value = stream("v");
      const entry = { value, tags: [], stale: 0, timestamp: 0, expire: 60, revalidate: 60 };
      await handler.set("k", Promise.resolve(entry));
      // Cancelled, not left unread.
      expect((await value.getReader().read()).done).toBe(true);
      expect(await handler.get("k", [])).toBeUndefined();
      expect(await handler.getExpiration(["t"])).toBe(0);
      await expect(handler.updateTags(["t"])).resolves.toBeUndefined();
    }
  });
});
