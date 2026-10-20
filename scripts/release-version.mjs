#!/usr/bin/env node
// Version policy for the release workflows (docs/publishing/RELEASE.md):
//
// - The package's major.minor never runs ahead of Next.js's latest stable release.
// - A version npm has ever seen is never used again. `npm view <pkg> time --json` lists every
//   version ever published, unpublished ones included (npm refuses to reuse those numbers).
//
//   node scripts/release-version.mjs check            fail if the package's major.minor is ahead of Next
//   node scripts/release-version.mjs check --unused   ...or if npm has ever seen the package's version
//   node scripts/release-version.mjs target <next>    print the version to bump to for Next <next>,
//                                                     or nothing when the package needs no bump
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_JSON = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "cache-handler",
  "package.json",
);

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Parse `16.4.3` or `16.4.3-rc.0`; throws on anything else. */
export function parseVersion(version) {
  const match = VERSION_RE.exec(version);
  if (!match) throw new Error(`Not a version: "${version}"`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifiers(a, b) {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Math.sign(Number(a) - Number(b));
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver precedence: -1, 0 or 1. A pre-release sorts before its release. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (const key of ["major", "minor", "patch"]) {
    if (x[key] !== y[key]) return Math.sign(x[key] - y[key]);
  }
  if (!x.pre.length || !y.pre.length) return Math.sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    const order = compareIdentifiers(x.pre[i], y.pre[i]);
    if (order) return order;
  }
  return 0;
}

/** The versions in `npm view <pkg> time --json` output (drops `created` / `modified`). */
export function usedVersions(time) {
  return new Set(Object.keys(time ?? {}).filter((key) => VERSION_RE.test(key)));
}

/**
 * The package version to release for Next.js `next`, or `null` when no bump is needed.
 *
 * The target is Next's version, moved up to the next patch npm has never seen (Next 16.5.0
 * gives 16.5.2 when 16.5.0 and 16.5.1 are burned). It is never lower than, or equal to, the
 * current version: a lower version would move npm `latest` back.
 */
export function pickTarget(next, current, used) {
  if (compareVersions(next, current) <= 0) return null;
  const { major, minor, patch, pre } = parseVersion(next);
  if (pre.length && used.has(next)) {
    throw new Error(`${next} is a pre-release npm has already seen; pick a version by hand`);
  }
  let target = next;
  for (let p = patch + 1; used.has(target); p++) {
    target = `${major}.${minor}.${p}`;
  }
  return target;
}

/** An error message when `pkg`'s major.minor is ahead of Next's `next`, else `null`. */
export function aheadOfNext(pkg, next) {
  const p = parseVersion(pkg);
  const n = parseVersion(next);
  if (p.major > n.major || (p.major === n.major && p.minor > n.minor)) {
    return (
      `Package version ${pkg} is ahead of Next.js ${next}: its major.minor (${p.major}.${p.minor}) ` +
      `must not be greater than Next's latest stable (${n.major}.${n.minor}). ` +
      `Release on ${n.major}.${n.minor}.x instead (docs/publishing/RELEASE.md).`
    );
  }
  return null;
}

function npmView(...args) {
  return execFileSync("npm", ["view", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function main(argv) {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
  const [command, arg] = argv;

  if (command === "check") {
    const next = npmView("next", "version");
    const ahead = aheadOfNext(pkg.version, next);
    if (ahead) throw new Error(ahead);
    if (arg === "--unused") {
      const used = usedVersions(JSON.parse(npmView(pkg.name, "time", "--json")));
      if (used.has(pkg.version)) {
        const where = `\`npm view ${pkg.name} time\`, unpublished versions included`;
        throw new Error(
          `${pkg.name}@${pkg.version} has been published before (${where}), so npm will refuse it. Use the next free patch.`,
        );
      }
    }
    console.log(`Version ${pkg.version} follows Next.js ${next}`);
    return;
  }

  if (command === "target") {
    if (!arg) throw new Error("Usage: release-version.mjs target <next-version>");
    const used = usedVersions(JSON.parse(npmView(pkg.name, "time", "--json")));
    const target = pickTarget(arg, pkg.version, used);
    if (target) console.log(target);
    return;
  }

  throw new Error("Usage: release-version.mjs check [--unused] | target <next-version>");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
