// CI proof: the global stamp must survive Next's standalone packaging with this build's ID.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const dist = resolve(process.argv[2] ?? "apps/e2e-test-app/.next");
const buildId = readFileSync(join(dist, "BUILD_ID"), "utf8").trim();
const stamps = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name === "cache-handler-build.json") stamps.push(path);
  }
}
walk(join(dist, "standalone"));
assert(stamps.length > 0, "standalone output omitted server/cache-handler-build.json");
for (const file of stamps) {
  const stamp = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(stamp.buildId, buildId, `wrong BUILD_ID in ${file}`);
  assert(Number.isFinite(stamp.buildTime) && stamp.buildTime > 0, `invalid build time in ${file}`);
  console.info(`Standalone build stamp verified: ${file} (${buildId})`);
}
