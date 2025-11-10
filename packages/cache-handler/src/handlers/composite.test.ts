import { describe, expect, test, vi } from "vitest";
import type { CacheHandler, CacheValue } from "../types.js";
import { CompositeHandler, createCompositeHandler } from "./composite.js";
import { createMemoryCacheHandler } from "./memory.js";

describe("CompositeHandler", () => {
  const createMockValue = (): CacheValue => ({
    kind: "FETCH",
    data: {
      headers: {},
      body: "test",
      status: 200,
      url: "https://example.com",
    },
    revalidate: false,
  });

  describe("constructor", () => {
    test("should throw error if no handlers provided", () => {
      expect(() => createCompositeHandler({ handlers: [] })).toThrow(
        "CompositeHandler requires at least one handler",
      );
    });

    test("should create handler with valid handlers", () => {
      const handler = createCompositeHandler({
        handlers: [createMemoryCacheHandler()],
      });

      expect(handler).toBeInstanceOf(CompositeHandler);
      expect(handler.name).toBe("composite");
    });
  });

  describe("get operations", () => {
    test("should return value from first handler", async () => {
      const handler1 = createMemoryCacheHandler();
      const handler2 = createMemoryCacheHandler();

      const value = createMockValue();
      await handler1.set("test-key", value);

      const composite = createCompositeHandler({
        handlers: [handler1, handler2],
      });

      const result = await composite.get("test-key");
      expect(result).toEqual(value);
    });

    test("should fallback to second handler if first has no value", async () => {
      const handler1 = createMemoryCacheHandler();
      const handler2 = createMemoryCacheHandler();

      const value = createMockValue();
      await handler2.set("test-key", value);

      const composite = createCompositeHandler({
        handlers: [handler1, handler2],
      });

      const result = await composite.get("test-key");
      expect(result).toEqual(value);
    });

    test("should return null if no handler has value", async () => {
      const handler1 = createMemoryCacheHandler();
      const handler2 = createMemoryCacheHandler();

      const composite = createCompositeHandler({
        handlers: [handler1, handler2],
      });

      const result = await composite.get("non-existent");
      expect(result).toBeNull();
    });

    test("should handle handler errors gracefully", async () => {
      const failingHandler: CacheHandler = {
        name: "failing-handler",
        get: vi.fn().mockRejectedValue(new Error("Handler failed")),
        set: vi.fn(),
        revalidateTag: vi.fn(),
      };

      const workingHandler = createMemoryCacheHandler();
      const value = createMockValue();
      await workingHandler.set("test-key", value);

      const composite = createCompositeHandler({
        handlers: [failingHandler, workingHandler],
      });

      // Should log error but continue to working handler
      const result = await composite.get("test-key");
      expect(result).toEqual(value);
    });

    test("should pass meta to handlers", async () => {
      const handler = createMemoryCacheHandler();
      const getSpy = vi.spyOn(handler, "get");

      const composite = createCompositeHandler({
        handlers: [handler],
      });

      await composite.get("test-key", { implicitTags: ["_N_T_/page"] });

      expect(getSpy).toHaveBeenCalledWith("test-key", {
        implicitTags: ["_N_T_/page"],
      });
    });
  });

  describe("set operations", () => {
    test("should write to all handlers by default", async () => {
      const handler1 = createMemoryCacheHandler();
      const handler2 = createMemoryCacheHandler();

      const composite = createCompositeHandler({
        handlers: [handler1, handler2],
      });

      const value = createMockValue();
      await composite.set("test-key", value);

      expect(await handler1.get("test-key")).toEqual(value);
      expect(await handler2.get("test-key")).toEqual(value);
    });

    test("should use setStrategy when provided", async () => {
      const handler1 = createMemoryCacheHandler();
      const handler2 = createMemoryCacheHandler();

      const composite = createCompositeHandler({
        handlers: [handler1, handler2],
        setStrategy: () => 1, // Always use second handler
      });

      const value = createMockValue();
      await composite.set("test-key", value);

      expect(await handler1.get("test-key")).toBeNull();
      expect(await handler2.get("test-key")).toEqual(value);
    });

    test("should route based on tags in setStrategy", async () => {
      const memoryHandler = createMemoryCacheHandler();
      const persistentHandler = createMemoryCacheHandler();

      const composite = createCompositeHandler({
        handlers: [memoryHandler, persistentHandler],
        setStrategy: (data) => {
          // Use memory handler for "memory-cache" tagged items
          return data.tags.includes("memory-cache") ? 0 : 1;
        },
      });

      const memoryValue = createMockValue();
      const persistentValue = createMockValue();

      await composite.set("memory-key", memoryValue, {
        tags: ["memory-cache"],
      });
      await composite.set("persistent-key", persistentValue, {
        tags: ["other"],
      });

      expect(await memoryHandler.get("memory-key")).toEqual(memoryValue);
      expect(await memoryHandler.get("persistent-key")).toBeNull();
      expect(await persistentHandler.get("persistent-key")).toEqual(persistentValue);
    });

    test("should handle handler failures gracefully", async () => {
      const failingHandler: CacheHandler = {
        name: "failing-handler",
        get: vi.fn(),
        set: vi.fn().mockRejectedValue(new Error("Set failed")),
        revalidateTag: vi.fn(),
      };

      const workingHandler = createMemoryCacheHandler();

      const composite = createCompositeHandler({
        handlers: [failingHandler, workingHandler],
      });

      const value = createMockValue();
      await composite.set("test-key", value);

      // Working handler should still have the value
      expect(await workingHandler.get("test-key")).toEqual(value);
    });
  });

  describe("revalidateTag operations", () => {
    test("should revalidate tag on all handlers", async () => {
      const handler1 = createMemoryCacheHandler();
      const handler2 = createMemoryCacheHandler();

      const value = createMockValue();
      await handler1.set("key1", value, { tags: ["test-tag"] });
      await handler2.set("key2", value, { tags: ["test-tag"] });

      const composite = createCompositeHandler({
        handlers: [handler1, handler2],
      });

      await composite.revalidateTag("test-tag");

      expect(await handler1.get("key1")).toBeNull();
      expect(await handler2.get("key2")).toBeNull();
    });

    test("should handle revalidation failures gracefully", async () => {
      const failingHandler: CacheHandler = {
        name: "failing-handler",
        get: vi.fn(),
        set: vi.fn(),
        revalidateTag: vi.fn().mockRejectedValue(new Error("Revalidate failed")),
      };

      const workingHandler = createMemoryCacheHandler();
      const value = createMockValue();
      await workingHandler.set("test-key", value, { tags: ["test-tag"] });

      const composite = createCompositeHandler({
        handlers: [failingHandler, workingHandler],
      });

      await composite.revalidateTag("test-tag");

      // Working handler should still be revalidated
      expect(await workingHandler.get("test-key")).toBeNull();
    });
  });

  describe("delete operations", () => {
    test("should delete from all handlers", async () => {
      const handler1 = createMemoryCacheHandler();
      const handler2 = createMemoryCacheHandler();

      const value = createMockValue();
      await handler1.set("test-key", value);
      await handler2.set("test-key", value);

      const composite = createCompositeHandler({
        handlers: [handler1, handler2],
      });

      await composite.delete("test-key");

      expect(await handler1.get("test-key")).toBeNull();
      expect(await handler2.get("test-key")).toBeNull();
    });

    test("should handle handlers without delete method", async () => {
      const handlerWithoutDelete: CacheHandler = {
        name: "no-delete-handler",
        get: vi.fn(),
        set: vi.fn(),
        revalidateTag: vi.fn(),
        // No delete method
      };

      const handlerWithDelete = createMemoryCacheHandler();
      const value = createMockValue();
      await handlerWithDelete.set("test-key", value);

      const composite = createCompositeHandler({
        handlers: [handlerWithoutDelete, handlerWithDelete],
      });

      await composite.delete("test-key");

      // Should only delete from handler that supports it
      expect(await handlerWithDelete.get("test-key")).toBeNull();
    });

    test("should handle delete failures gracefully", async () => {
      const failingHandler: CacheHandler = {
        name: "failing-handler",
        get: vi.fn(),
        set: vi.fn(),
        revalidateTag: vi.fn(),
        delete: vi.fn().mockRejectedValue(new Error("Delete failed")),
      };

      const workingHandler = createMemoryCacheHandler();
      const value = createMockValue();
      await workingHandler.set("test-key", value);

      const composite = createCompositeHandler({
        handlers: [failingHandler, workingHandler],
      });

      await composite.delete("test-key");

      // Working handler should still be deleted
      expect(await workingHandler.get("test-key")).toBeNull();
    });
  });
});
