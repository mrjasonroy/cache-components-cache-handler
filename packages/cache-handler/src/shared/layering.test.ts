/**
 * The module layers: `shared/` is the base and imports nothing from the handler folders, and a
 * handler does not borrow from a sibling handler what belongs in `shared/`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Relative import specifiers of a source file, static and dynamic. */
function relativeImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/(?:from|import\()\s*"(\.{1,2}\/[^"]+)"/g)].map((match) => match[1]);
}

function sources(dir: string): string[] {
  return readdirSync(join(src, dir))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => join(src, dir, name));
}

describe("module layers", () => {
  test("shared/ imports only from shared/", () => {
    const outside = sources("shared").flatMap((file) =>
      relativeImports(file)
        .filter((specifier) => specifier.startsWith("../"))
        .map((specifier) => `${file.slice(src.length + 1)} -> ${specifier}`),
    );
    expect(outside).toEqual([]);
  });

  test("the local data handler takes nothing from the remote one", () => {
    expect(relativeImports(join(src, "data-cache", "local.ts"))).not.toContain("./remote.js");
  });
});
