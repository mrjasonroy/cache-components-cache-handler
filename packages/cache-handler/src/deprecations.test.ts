/**
 * The legacy data cache stack, the Next 14 handlers' types and `RedisCacheHandler.close()` are
 * deprecated in 16.4.3: each keeps
 * working in 16.x, and its JSDoc says so and names the replacement, so editors strike it through.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const src = dirname(fileURLToPath(import.meta.url));

/** The JSDoc block directly above `declaration` in `file`. */
function jsdocOf(file: string, declaration: string): string {
  const text = readFileSync(join(src, file), "utf8");
  const at = text.indexOf(declaration);
  expect(at, `${declaration} in ${file}`).toBeGreaterThan(-1);
  const before = text.slice(0, at).trimEnd();
  expect(before.endsWith("*/"), `JSDoc above ${declaration}`).toBe(true);
  return before.slice(before.lastIndexOf("/**"));
}

describe("deprecations", () => {
  test.each([
    ["data-cache/factory.ts", "export function createCacheHandler(", "withCache"],
    [
      "data-cache/redis.ts",
      "export function createRedisDataCacheHandler(",
      "createRemoteCacheHandler",
    ],
    [
      "data-cache/memory.ts",
      "export function createMemoryDataCacheHandler(",
      "createLocalCacheHandler",
    ],
    [
      "data-cache/ioredis-adapter.ts",
      "export function createIoredisAdapter(",
      "createRemoteCacheHandler",
    ],
    ["handlers/redis.ts", "  async close(): Promise<void>", "closeCache"],
    // The Next 14 types, used only by the deprecated memory and composite handlers.
    ["types.ts", "export type CacheValue =", "PageCacheValue"],
    ["types.ts", "export interface LifespanParameters {", "no replacement"],
    ["types.ts", "export interface CacheHandlerValue {", "PageCacheHandlerValue"],
    ["types.ts", "export interface CacheHandlerContext {", "PageCacheHandlerContext"],
    ["types.ts", "export interface CacheHandlerGetMeta {", "PageCacheGetContext"],
    ["types.ts", "export interface CacheHandler {", "withCache"],
    ["types.ts", "export interface CacheHandlerOptions {", "withCache"],
    ["handlers/memory.ts", "export interface MemoryCacheHandlerOptions ", "withCache"],
    ["handlers/composite.ts", "export interface CompositeHandlerOptions ", "withCache"],
  ])("%s: %s is @deprecated in favour of %s", (file, declaration, replacement) => {
    const jsdoc = jsdocOf(file, declaration);
    expect(jsdoc).toMatch(/@deprecated/);
    expect(jsdoc.slice(jsdoc.indexOf("@deprecated"))).toContain(replacement);
  });
});
