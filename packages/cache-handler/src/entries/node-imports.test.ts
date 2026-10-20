import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const src = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Every module specifier a file loads at runtime: the file is compiled as `tsc` would emit it, so
 * type-only imports are gone, then its imports, re-exports, `import()` and `require()` are read.
 */
function runtimeSpecifiers(file: string): string[] {
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  });
  const out = ts.createSourceFile(file, outputText, ts.ScriptTarget.ES2022, true);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const isLoader =
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require");
      const [arg] = node.arguments;
      if (isLoader && arg && ts.isStringLiteralLike(arg)) specifiers.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(out);
  return specifiers;
}

/** The modules each file of the graph rooted at `entry` loads from outside the package. */
function externalImports(entry: string): Map<string, string[]> {
  const seen = new Set<string>();
  const external = new Map<string, string[]>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of runtimeSpecifiers(file)) {
      if (specifier.startsWith(".")) {
        walk(join(dirname(file), specifier.replace(/\.js$/, ".ts")));
      } else {
        const name = relative(src, file);
        external.set(name, [...(external.get(name) ?? []), specifier]);
      }
    }
  };
  walk(entry);
  return external;
}

describe("handler entries' import graph (bundled into the edge middleware)", () => {
  test.each(["page", "remote", "default"])(
    "entries/%s.ts loads no Node built-in or package at import time",
    (entry) => {
      // Turbopack's edge build fails on loading any `node:` module, and a package (ioredis) would
      // pull its own built-ins in. Both are reached on first use only (shared/node-require.ts).
      expect(Object.fromEntries(externalImports(join(src, "entries", `${entry}.ts`)))).toEqual({});
    },
  );

  test("the package root loads no Node built-in or package at import time", () => {
    // A custom handler file imports `createRedisCacheHandler` from the root, and Next bundles that
    // file into the edge middleware too.
    expect(Object.fromEntries(externalImports(join(src, "index.ts")))).toEqual({});
  });

  test("the check sees static, re-exported and dynamic imports, and skips type-only ones", () => {
    // No source file imports a built-in any more; this test file does.
    expect(runtimeSpecifiers(join(src, "entries", "node-imports.test.ts"))).toContain("node:fs");
    expect(runtimeSpecifiers(join(src, "shared", "connection.ts"))).not.toContain("ioredis");
  });
});
