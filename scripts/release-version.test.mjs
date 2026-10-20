//   node --test scripts/
import assert from "node:assert/strict";
import { test } from "node:test";
import { aheadOfNext, compareVersions, pickTarget, usedVersions } from "./release-version.mjs";

const burned = usedVersions({
  created: "2025-11-01T00:00:00.000Z",
  modified: "2026-10-19T00:00:00.000Z",
  "16.4.2": "2026-10-18T00:23:29.987Z",
  "16.4.3-rc.0": "2026-10-20T00:00:00.000Z",
  "16.5.0": "2026-10-19T01:59:52.584Z",
  "16.5.1": "2026-10-19T16:51:26.793Z",
});

test("usedVersions keeps versions only", () => {
  assert.deepEqual([...burned].sort(), ["16.4.2", "16.4.3-rc.0", "16.5.0", "16.5.1"]);
});

test("compareVersions orders releases and pre-releases", () => {
  assert.equal(compareVersions("16.4.3", "16.4.2"), 1);
  assert.equal(compareVersions("16.4.3-rc.0", "16.4.3"), -1);
  assert.equal(compareVersions("16.4.3-rc.0", "16.4.2"), 1);
  assert.equal(compareVersions("16.4.3-rc.10", "16.4.3-rc.9"), 1);
  assert.equal(compareVersions("16.10.0", "16.9.9"), 1);
  assert.equal(compareVersions("16.5.2", "16.5.2"), 0);
});

test("Next 16.5.0 skips the burned 16.5.0 and 16.5.1", () => {
  assert.equal(pickTarget("16.5.0", "16.4.3", burned), "16.5.2");
  assert.equal(pickTarget("16.5.0", "16.4.3-rc.0", burned), "16.5.2");
});

test("Next patches below or equal to the package do not bump it (never lower)", () => {
  assert.equal(pickTarget("16.5.1", "16.5.2", burned), null);
  assert.equal(pickTarget("16.5.2", "16.5.2", burned), null);
  assert.equal(pickTarget("16.4.2", "16.4.3", burned), null);
  assert.equal(pickTarget("16.4.3", "16.4.3", burned), null);
});

test("an unused Next version is taken as is", () => {
  assert.equal(pickTarget("16.5.3", "16.5.2", burned), "16.5.3");
  assert.equal(pickTarget("16.4.3", "16.4.3-rc.0", burned), "16.4.3");
  assert.equal(pickTarget("17.0.0", "16.5.2", burned), "17.0.0");
});

test("the guard rejects a major.minor ahead of Next", () => {
  assert.match(aheadOfNext("16.6.0", "16.4.2"), /16\.6\.0 is ahead of Next\.js 16\.4\.2/);
  assert.match(aheadOfNext("16.5.0", "16.4.2"), /ahead/);
  assert.match(aheadOfNext("17.0.0", "16.9.0"), /ahead/);
  assert.equal(aheadOfNext("16.4.3-rc.0", "16.4.2"), null);
  assert.equal(aheadOfNext("16.4.9", "16.4.2"), null);
  assert.equal(aheadOfNext("16.5.2", "16.5.0"), null);
  assert.equal(aheadOfNext("16.4.3", "17.0.0"), null);
});
