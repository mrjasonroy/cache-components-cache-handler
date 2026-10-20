// End-to-end checks of the gate: count-results.mjs turns a jest log into result rows, as
// run-suites.sh does, and report.mjs must exit 1 exactly when a baseline-passing test regressed.
//
//   node --test tests/next-deploy/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SUITE = "test/e2e/app";
const FILE = "test/e2e/app/app.test.ts";

/** One variant's results for FILE: [fullName, status] pairs, through count-results.mjs. */
function writeVariant(dir, variant, assertions) {
  const json = {
    testResults: [
      {
        name: `/next.js/${FILE}`,
        assertionResults: assertions.map(([fullName, status]) => ({ fullName, status })),
      },
    ],
    numPassedTests: assertions.filter(([, status]) => status === "passed").length,
    numFailedTests: assertions.filter(([, status]) => status === "failed").length,
    numTotalTests: assertions.length,
  };
  const log = join(dir, `${variant}.log`);
  writeFileSync(log, `--test output start-- ${JSON.stringify(json)} --test output end--\n`);
  const counted = spawnSync(process.execPath, [join(here, "count-results.mjs"), log, FILE], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      COUNT_RESULTS_TESTS_FILE: join(dir, "results", `${variant}-1.tests.jsonl`),
      COUNT_RESULTS_SUITE: SUITE,
    },
  });
  assert.equal(counted.status, 0, counted.stderr);
  const [passed, failed, skipped, total] = counted.stdout.trim().split("\t");
  const status = Number(failed) > 0 ? "fail" : "pass";
  writeFileSync(
    join(dir, "results", `${variant}-1.tsv`),
    `${SUITE}\t${status}\t1\t1\t${passed}\t${failed}\t${skipped}\t${total}\n#complete\n`,
  );
}

/** report.mjs's exit code for baseline and branch results. */
function gate(baseline, branch) {
  const dir = mkdtempSync(join(tmpdir(), "next-deploy-report-"));
  try {
    mkdirSync(join(dir, "results"));
    writeVariant(dir, "baseline", baseline);
    writeVariant(dir, "pkg-16.4.2", baseline);
    writeVariant(dir, "branch", branch);
    writeFileSync(join(dir, "known.txt"), "");
    const report = spawnSync(
      process.execPath,
      [
        join(here, "report.mjs"),
        join(dir, "results"),
        join(dir, "known.txt"),
        "1",
        join(dir, "out"),
      ],
      { encoding: "utf8", env: { ...process.env, BASELINE_MIN_PASS_RATE: "0" } },
    );
    return report.status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the same results pass the gate", () => {
  const results = [
    ["app one", "passed"],
    ["app two", "failed"],
  ];
  assert.equal(gate(results, results), 0);
});

test("an exchanged failure between two names fails the gate", () => {
  assert.equal(
    gate(
      [
        ["app one", "passed"],
        ["app two", "failed"],
      ],
      [
        ["app one", "failed"],
        ["app two", "passed"],
      ],
    ),
    1,
  );
});

test("names that differ only in whitespace stay distinct", () => {
  assert.equal(
    gate(
      [
        ["a  b", "passed"],
        ["a b", "failed"],
      ],
      [
        ["a  b", "failed"],
        ["a b", "passed"],
      ],
    ),
    1,
  );
});

test("a duplicated name is compared by how many of it pass", () => {
  assert.equal(
    gate(
      [
        ["same", "passed"],
        ["same", "failed"],
        ["other", "failed"],
      ],
      [
        ["same", "failed"],
        ["same", "failed"],
        ["other", "passed"],
      ],
    ),
    1,
  );
  // Which of two identical names passes cannot be told apart, and is not a regression.
  assert.equal(
    gate(
      [
        ["same", "passed"],
        ["same", "failed"],
      ],
      [
        ["same", "failed"],
        ["same", "passed"],
      ],
    ),
    0,
  );
});
