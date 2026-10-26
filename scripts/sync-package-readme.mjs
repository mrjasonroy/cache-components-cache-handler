#!/usr/bin/env node
/**
 * The README published to npm (packages/cache-handler/README.md) is the root README with its
 * repository-relative links made absolute, since npm cannot resolve them.
 *
 *   node scripts/sync-package-readme.mjs          write the package README
 *   node scripts/sync-package-readme.mjs --check  exit 1 if it is out of date
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "README.md");
const target = join(root, "packages/cache-handler/README.md");
const base = "https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/";

export function packageReadme(text) {
  return text.replace(/\]\(\.\/([^)]+)\)/g, (_, path) => `](${base}${path})`);
}

const expected = packageReadme(readFileSync(source, "utf8"));

if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== expected) {
    console.error(
      "packages/cache-handler/README.md is out of date with README.md: run `pnpm readme:sync`.",
    );
    process.exit(1);
  }
} else {
  writeFileSync(target, expected);
}
