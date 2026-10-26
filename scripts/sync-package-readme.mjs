#!/usr/bin/env node
/**
 * The README published to npm (packages/cache-handler/README.md) is the root README with its
 * repository-relative links made absolute, since npm cannot resolve them.
 *
 *   node scripts/sync-package-readme.mjs          write the package README
 *   node scripts/sync-package-readme.mjs --check  exit 1 if it is out of date
 *
 * Both fail if a link or image would still be relative after the rewrite: every target must be
 * absolute (http, https, mailto) or a pure #anchor.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LINK_BASE = "https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/";

/** Rewrite `./path` targets (inline links and images, reference definitions, HTML attributes). */
export function packageReadme(text) {
  return text
    .replace(/\]\(\.\/([^)]+)\)/g, (_, path) => `](${LINK_BASE}${path})`)
    .replace(/^(\s*\[[^\]]+\]:\s*<?)\.\/(\S+)/gm, (_, head, path) => `${head}${LINK_BASE}${path}`)
    .replace(
      /\b(src|href)(\s*=\s*["'])\.\/([^"']+)/gi,
      (_, attr, eq, path) => `${attr}${eq}${LINK_BASE}${path}`,
    );
}

function isAbsolute(target) {
  return /^(https?:|mailto:)/i.test(target) || /^#\S*$/.test(target);
}

/** Every link or image target in `text` that is neither absolute nor a pure #anchor. */
export function relativeLinks(text) {
  // Code is not rendered as links: fenced blocks and inline spans are skipped.
  const prose = text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
    .replace(/`[^`\n]*`/g, "");
  const targets = [
    ...[...prose.matchAll(/\]\(\s*<?([^)\s>]+)/g)].map((m) => m[1]),
    ...[...prose.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)/gm)].map((m) => m[1]),
    ...[...prose.matchAll(/\b(?:src|href)\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]),
  ];
  return targets.filter((target) => !isAbsolute(target));
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const target = join(root, "packages/cache-handler/README.md");
  const expected = packageReadme(readFileSync(join(root, "README.md"), "utf8"));

  const relative = relativeLinks(expected);
  if (relative.length > 0) {
    console.error(
      `README.md has links the npm README cannot resolve (use ./path or an absolute URL): ${relative.join(", ")}`,
    );
    process.exit(1);
  }

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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
