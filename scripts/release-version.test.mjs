//   node --test scripts/
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aheadOfNext,
  bumpPeer,
  compareVersions,
  peerMismatch,
  peerRange,
  pickTarget,
  releaseChangelog,
  usedVersions,
} from "./release-version.mjs";

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
  assert.equal(pickTarget("16.5.0", "16.4.3-rc.0", burned), null);
});

test("Next patches below or equal to the package do not bump it (never lower)", () => {
  assert.equal(pickTarget("16.5.1", "16.5.2", burned), null);
  assert.equal(pickTarget("16.5.2", "16.5.2", burned), null);
  assert.equal(pickTarget("16.4.2", "16.4.3", burned), null);
  assert.equal(pickTarget("16.4.3", "16.4.3", burned), null);
});

test("an unused Next version is taken as is", () => {
  assert.equal(pickTarget("16.5.3", "16.5.2", burned), "16.5.3");
  assert.equal(pickTarget("16.4.3", "16.4.3-rc.0", burned), null);
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

test("the next peer pins the package's major.minor, an RC by its base", () => {
  assert.equal(peerRange("16.4.3"), "~16.4.0");
  assert.equal(peerRange("16.5.2"), "~16.5.0");
  assert.equal(peerRange("16.5.2-rc.0"), "~16.5.0");
  assert.equal(peerRange("17.0.0"), "~17.0.0");
});

test("a bump to a new Next major.minor moves the peer", () => {
  assert.equal(bumpPeer("~16.4.0", "16.4.3", "16.5.2"), "~16.5.0");
  assert.equal(bumpPeer("~16.4.0", "16.4.4", "16.5.2-rc.0"), "~16.5.0");
  assert.equal(bumpPeer("~16.4.0", "16.4.4-rc.1", "16.5.2"), "~16.5.0");
  assert.equal(bumpPeer("~16.9.0", "16.9.1", "17.0.0"), "~17.0.0");
  assert.equal(bumpPeer("^16.0.0", "16.4.3", "16.5.2"), "~16.5.0");
});

test("a patch or pre-release bump within the minor leaves the peer untouched", () => {
  assert.equal(bumpPeer("~16.4.0", "16.4.3", "16.4.4"), "~16.4.0");
  assert.equal(bumpPeer("~16.4.0", "16.4.3", "16.4.4-rc.0"), "~16.4.0");
  assert.equal(bumpPeer("~16.4.0", "16.4.4-rc.0", "16.4.4-rc.1"), "~16.4.0");
  assert.equal(bumpPeer("~16.4.0", "16.4.4-rc.1", "16.4.4"), "~16.4.0");
  assert.equal(bumpPeer("~16.5.0", "16.5.2", "16.5.3"), "~16.5.0");
});

test("the guard rejects a peer that does not pin the package's minor", () => {
  const pkg = (version, next) => ({ version, peerDependencies: { next } });
  assert.equal(peerMismatch(pkg("16.4.3", "~16.4.0")), null);
  assert.equal(peerMismatch(pkg("16.5.2-rc.0", "~16.5.0")), null);
  assert.match(peerMismatch(pkg("16.4.3", "^16.0.0")), /"\^16\.0\.0".*"~16\.4\.0"/);
  assert.match(peerMismatch(pkg("16.5.2", "~16.4.0")), /~16\.5\.0/);
  assert.match(peerMismatch({ version: "16.4.3" }), /undefined/);
});

const changelog = (...sections) =>
  `# Changelog\n\nIntro.\n\n${sections.join("\n")}\n## [16.4.3] - 2026-10-26\n\nOld notes.\n`;

test("a release renames Unreleased to its dated version", () => {
  const before = changelog("## [Unreleased]\n\n- Pinned peer.\n");
  assert.equal(
    releaseChangelog(before, "16.4.4", "2026-11-02"),
    changelog("## [16.4.4] - 2026-11-02\n\n- Pinned peer.\n"),
  );
});

test("a pre-release renames Unreleased to its base version, undated", () => {
  const before = changelog("## [Unreleased]\n\n- Pinned peer.\n");
  assert.equal(
    releaseChangelog(before, "16.4.4-rc.0", "2026-11-02"),
    changelog("## [16.4.4]\n\n- Pinned peer.\n"),
  );
});

test("later RCs and the final merge Unreleased into the RC's section and date it", () => {
  const rc0 = changelog("## [16.4.4]\n\n- First.\n");
  const rc1 = releaseChangelog(
    changelog("## [Unreleased]\n\n- Second.\n", "## [16.4.4]\n\n- First.\n"),
    "16.4.4-rc.1",
    "2026-11-02",
  );
  assert.equal(rc1, changelog("## [16.4.4]\n\n- First.\n\n- Second.\n"));
  assert.equal(
    releaseChangelog(rc0, "16.4.4", "2026-11-03"),
    changelog("## [16.4.4] - 2026-11-03\n\n- First.\n"),
  );
  assert.equal(
    releaseChangelog(
      changelog("## [Unreleased]\n\n", "## [16.4.4]\n\n- First.\n"),
      "16.4.4",
      "2026-11-03",
    ),
    changelog("## [16.4.4] - 2026-11-03\n\n- First.\n"),
  );
});

test("nothing pending leaves the changelog as it is", () => {
  const text = changelog();
  assert.equal(releaseChangelog(text, "16.4.4", "2026-11-02"), text);
  assert.equal(releaseChangelog(text, "16.4.3", "2026-11-02"), text);
  assert.equal(releaseChangelog(text, "16.5.2-rc.0", "2026-11-02"), text);
});

test("merged Unreleased entries go after the section's intro and subsections", () => {
  const rc0 =
    "## [16.4.4]\n\nIntro paragraph.\n\n### Fixed\n\n- First fix.\n\n### Changed\n\n- First change.\n";
  const before = changelog("## [Unreleased]\n\n### Fixed\n\n- Second fix.\n", rc0);
  assert.equal(
    releaseChangelog(before, "16.4.4", "2026-11-03"),
    changelog(
      "## [16.4.4] - 2026-11-03\n\nIntro paragraph.\n\n### Fixed\n\n- First fix.\n\n### Changed\n\n" +
        "- First change.\n\n### Fixed\n\n- Second fix.\n",
    ),
  );
});

test("merging into the last section of the file keeps one trailing newline", () => {
  const before =
    "# Changelog\n\n## [Unreleased]\n\n- Second.\n\n## [16.4.4]\n\nIntro.\n\n- First.\n";
  assert.equal(
    releaseChangelog(before, "16.4.4-rc.1", "2026-11-03"),
    "# Changelog\n\n## [16.4.4]\n\nIntro.\n\n- First.\n\n- Second.\n",
  );
});
