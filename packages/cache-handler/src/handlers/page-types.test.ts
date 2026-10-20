import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("PageCacheHandlerContext", () => {
  test("is declared on its own, not on the deprecated Next 14 handler types", () => {
    const source = readFileSync(new URL("./page-types.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from "\.\.\/types\.js"/);
  });
});
