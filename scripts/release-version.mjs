#!/usr/bin/env node
// Version policy for the release workflows (docs/publishing/RELEASE.md):
//
// - The package's major.minor never runs ahead of Next.js's latest stable release.
// - A version npm has ever seen is never used again. `npm view <pkg> time --json` lists every
//   version ever published, unpublished ones included (npm refuses to reuse those numbers).
// - The package is pinned to the app's Next.js minor: its `next` peer is `~<major>.<minor>.0`.
//
//   node scripts/release-version.mjs check            fail if the package's major.minor is ahead of Next
//   node scripts/release-version.mjs check --unused   ...or if npm has ever seen the package's version
//   node scripts/release-version.mjs target <next>    print the version to bump to for Next <next>,
//                                                     or nothing when the package needs no bump
//   node scripts/release-version.mjs sync <previous>  after a bump from <previous>: move the `next`
//                                                     peer to the new major.minor, and rename
//                                                     CHANGELOG.md's "## [Unreleased]" section
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_JSON = join(ROOT, "packages", "cache-handler", "package.json");
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const RELEASE_DOC = "docs/publishing/RELEASE.md";

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
 * current version: a lower version would move npm `latest` back. While the package is on a
 * pre-release (an RC on staging), it returns `null`: the loop must not publish that untested code
 * to `latest` by itself, so a person graduates the RC.
 */
export function pickTarget(next, current, used) {
  if (parseVersion(current).pre.length) return null;
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

/** The `next` peer range for package `version`: `~<major>.<minor>.0` (an RC uses its base). */
export function peerRange(version) {
  const { major, minor } = parseVersion(version);
  return `~${major}.${minor}.0`;
}

/** An error message when the `next` peer is not the range for the package's version, else `null`. */
export function peerMismatch(pkg) {
  const peer = pkg.peerDependencies?.next;
  const expected = peerRange(pkg.version);
  if (peer === expected) return null;
  const fix = "node scripts/release-version.mjs sync <previous version>";
  return (
    `The "next" peer dependency is ${JSON.stringify(peer)}, but package ${pkg.version} must pin ` +
    `Next's minor: "${expected}". Run \`${fix}\` or set it by hand (${RELEASE_DOC}).`
  );
}

/**
 * The `next` peer after a bump from `previous` to `current`. A bump to a new major.minor (an RC
 * counts by its base version) moves it to `~<major>.<minor>.0`; a patch or pre-release bump within
 * the same major.minor leaves `peer` as it is.
 */
export function bumpPeer(peer, previous, current) {
  const from = parseVersion(previous);
  const to = parseVersion(current);
  if (from.major === to.major && from.minor === to.minor) return peer;
  return peerRange(current);
}

const UNRELEASED_RE = /^## \[Unreleased\][^\n]*\n/im;

/**
 * CHANGELOG.md text after bumping to `version`, so publish.yml finds the release's section under
 * "## [<base version>]" (an RC uses its final version's section).
 *
 * - "## [Unreleased]" becomes "## [<base>] - <date>" for a release, or "## [<base>]" for a
 *   pre-release (dated when the final ships).
 * - When "## [<base>]" already exists (an earlier RC), the Unreleased entries are appended to the
 *   end of it (its intro stays first; a repeated ### heading is not merged), and a release dates its heading if it has no date yet.
 * - With no Unreleased section and nothing to date, the text is returned unchanged.
 */
export function releaseChangelog(text, version, date) {
  const { major, minor, patch, pre } = parseVersion(version);
  const base = `${major}.${minor}.${patch}`;
  const heading = pre.length ? `## [${base}]` : `## [${base}] - ${date}`;
  const escaped = base.replaceAll(".", "\\.");
  const existingRe = new RegExp(`^## \\[${escaped}\\]([^\\n]*)\\n`, "m");

  let out = text;
  const unreleased = UNRELEASED_RE.exec(out);
  if (unreleased) {
    const start = unreleased.index;
    const bodyStart = start + unreleased[0].length;
    const nextHeading = out.slice(bodyStart).search(/^## \[/m);
    const bodyEnd = nextHeading === -1 ? out.length : bodyStart + nextHeading;
    const body = out.slice(bodyStart, bodyEnd);
    const rest = out.slice(0, start) + out.slice(bodyEnd);
    const existing = existingRe.exec(rest);
    if (existing && !body.trim()) {
      out = rest;
    } else if (existing) {
      // Append at the end of the existing section, so its intro stays first.
      const sectionStart = existing.index + existing[0].length;
      const following = rest.slice(sectionStart).search(/^## \[/m);
      const at = following === -1 ? rest.length : sectionStart + following;
      const section = rest.slice(0, at).replace(/\n+$/, "");
      const after = rest.slice(at);
      out = `${section}\n\n${body.trim()}\n${after ? `\n${after}` : ""}`;
    } else {
      out = `${out.slice(0, start)}${heading}\n${out.slice(bodyStart)}`;
    }
  }

  if (!pre.length) {
    const existing = existingRe.exec(out);
    if (existing && !/\d{4}-\d{2}-\d{2}/.test(existing[1])) {
      out = `${out.slice(0, existing.index)}${heading}\n${out.slice(existing.index + existing[0].length)}`;
    }
  }
  return out;
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
    const peer = peerMismatch(pkg);
    if (peer) throw new Error(peer);
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

  if (command === "sync") {
    if (!arg) throw new Error("Usage: release-version.mjs sync <previous-version>");
    const peer = bumpPeer(pkg.peerDependencies?.next, arg, pkg.version);
    if (peer !== pkg.peerDependencies?.next) {
      pkg.peerDependencies = { ...pkg.peerDependencies, next: peer };
      writeFileSync(PACKAGE_JSON, `${JSON.stringify(pkg, null, 2)}\n`);
      console.log(`next peer: ${peer}`);
    }
    const date = new Date().toISOString().slice(0, 10);
    const changelog = readFileSync(CHANGELOG, "utf8");
    const released = releaseChangelog(changelog, pkg.version, date);
    if (released !== changelog) {
      writeFileSync(CHANGELOG, released);
      console.log(`CHANGELOG.md: release notes under ## [${pkg.version.replace(/-.*$/, "")}]`);
    }
    return;
  }

  throw new Error(
    "Usage: release-version.mjs check [--unused] | target <next-version> | sync <previous-version>",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
