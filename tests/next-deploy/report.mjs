#!/usr/bin/env node
// Aggregates the shard results of every variant into one per-suite report and decides the job.
//
//   node report.mjs <resultsDir> <knownFailuresFile> <shards> <outDir>
//
// Writes <outDir>/<ref>.json (per-suite status and test counts per variant; the committed
// baseline file is a copy of it) and <outDir>/<ref>.md (the same as a table, also appended to
// the job summary). <ref> is NEXT_REF, e.g. v16.4.2.
//
// Exit 1 only when `branch` ran and either
//   - a suite passes on `baseline` and does not pass on `branch`, passes fewer tests on `branch`
//     than on `baseline`, or has a test, by name, that passes on `baseline` and not on `branch`
//     (from <variant>-<shard>.tests.jsonl; without it, counts only), and is not in
//     known-failures.txt, or
//   - `baseline` or `branch` results are incomplete (a shard never finished, or a suite has no
//     result: its path matched no files), since a missing result can hide a regression.
// `pkg-16.4.2` is informational. A skipped `branch` (no withCache yet) never fails the job.
//
// known-failures.txt lines are `<suite> [<constraint>] <reason>`. The optional constraint limits
// the entry to some Next.js versions, compared with NEXT_REF: `<16.5.0-canary.10` applies only
// below that version (`<`, `<=`, `>`, `>=` all work). An entry with a constraint is a bug in
// Next itself, and its verdict reads "known Next bug". A ref that is not a version (a branch, a
// sha) matches every constraint.
//
// Independently of `branch`, exit 1 when `baseline` looks like a broken harness: fewer than
// BASELINE_MIN_PASS_RATE (default 0.5) of the baseline tests that ran passed, or none ran. Plain
// `next start` passes most of these suites, so a low rate means the deploy script or runner is
// broken, and every comparison against it is meaningless.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const [resultsDir, knownFailuresFile, shardsArg, outDir] = process.argv.slice(2);
const shards = Number(shardsArg);
if (!resultsDir || !knownFailuresFile || !shards || !outDir) {
  console.error("usage: report.mjs <resultsDir> <knownFailuresFile> <shards> <outDir>");
  process.exit(2);
}

const ref = process.env.NEXT_REF ?? "unknown";
const VARIANTS = ["baseline", "pkg-16.4.2", "branch"];
// Variants that wire handlers in; their Notes go in the table.
const HANDLER_VARIANTS = VARIANTS.filter((variant) => variant !== "baseline");
// Worst part wins; "skipped" only when every part was skipped (the deploy manifest drops files).
const RANK = { skipped: 0, pass: 1, missing: 2, timeout: 3, fail: 4 };

function readRows(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

/** `v16.5.0-canary.10` -> [16, 5, 0, 10]; a release sorts after its prereleases. */
function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-[a-z]+\.(\d+))?$/.exec(text ?? "");
  if (!match) return null;
  const [, major, minor, patch, pre] = match;
  return [
    Number(major),
    Number(minor),
    Number(patch),
    pre === undefined ? Number.POSITIVE_INFINITY : Number(pre),
  ];
}

function compareVersions(a, b) {
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** Whether a constraint such as `<16.5.0-canary.10` holds for the ref under test. */
function refMatches(constraint) {
  const match = /^(<=|>=|<|>)(.+)$/.exec(constraint);
  const bound = match && parseVersion(match[2]);
  if (!bound) throw new Error(`known-failures.txt: bad version constraint ${constraint}`);
  const current = parseVersion(ref);
  if (!current) return true;
  const order = compareVersions(current, bound);
  return { "<": order < 0, "<=": order <= 0, ">": order > 0, ">=": order >= 0 }[match[1]];
}

/** suite -> { reason, nextBug } for the entries that apply to this ref. */
const known = new Map();
for (const line of existsSync(knownFailuresFile) ? readRows(knownFailuresFile) : []) {
  if (line.trim().startsWith("#")) continue;
  const [suite, ...rest] = line.trim().split(/\s+/);
  const constraint = /^[<>]/.test(rest[0] ?? "") ? rest.shift() : null;
  if (constraint && !refMatches(constraint)) continue;
  known.set(suite, { reason: rest.join(" "), nextBug: Boolean(constraint) });
}

/** variant -> { state: "ran" | "skipped", reason?, incomplete: string[] } */
const variants = {};
/** suite -> variant -> { status, seconds, passed, failed, skipped, total, notes } */
const suites = new Map();

for (const variant of VARIANTS) {
  const info = { state: "ran", incomplete: [] };
  variants[variant] = info;

  for (let shard = 1; shard <= shards; shard++) {
    const file = join(resultsDir, `${variant}-${shard}.tsv`);
    if (!existsSync(file)) {
      info.incomplete.push(`shard ${shard}: no results`);
      continue;
    }
    const rows = readRows(file);
    if (!rows.includes("#complete")) {
      info.incomplete.push(`shard ${shard}: did not finish`);
    }
    for (const row of rows) {
      const [suite, status, seconds, , passed, failed, skipped, total] = row.split("\t");
      if (suite === "#skipped") {
        info.state = "skipped";
        info.reason = status;
        continue;
      }
      if (suite.startsWith("#")) continue;

      const bySuite = suites.get(suite) ?? {};
      const previous = bySuite[variant];
      const merged = previous ?? {
        status: "skipped",
        seconds: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        total: 0,
      };
      // Older shard files marked an all-skipped part "pass"; nothing passed, so nothing ran.
      const partStatus =
        status === "pass" && Number(passed) === 0 && Number(failed) === 0 ? "skipped" : status;
      if (!previous || RANK[partStatus] > RANK[merged.status]) {
        merged.status = partStatus in RANK ? partStatus : "fail";
      }
      merged.seconds += Number(seconds) || 0;
      merged.passed += Number(passed) || 0;
      merged.failed += Number(failed) || 0;
      merged.skipped += Number(skipped) || 0;
      merged.total += Number(total) || 0;
      bySuite[variant] = merged;
      suites.set(suite, bySuite);
    }
  }
}

for (const file of readdirSync(resultsDir).filter((name) => name.endsWith(".notes.tsv"))) {
  const variant = VARIANTS.find((v) => file.startsWith(`${v}-`));
  for (const row of readRows(join(resultsDir, file))) {
    const [suite, note] = row.split("\t");
    const entry = suites.get(suite)?.[variant];
    if (entry && note) {
      entry.notes = [...new Set([...(entry.notes ?? []), ...note.split("; ")])];
    }
  }
}

/**
 * variant -> suite -> test identity -> how many tests of that identity passed, from
 * <variant>-<shard>.tests.jsonl. The identity is the file and the exact jest full name. Jest can
 * report the same full name more than once in a file; which of them passed cannot be told apart,
 * so they are compared by how many passed. A suite reported by several result files (a retry in
 * another shard) keeps the fewest passed: a test counts as passed only if it always passed.
 */
const tests = Object.fromEntries(VARIANTS.map((variant) => [variant, new Map()]));
for (const file of readdirSync(resultsDir).filter((name) => name.endsWith(".tests.jsonl"))) {
  const variant = VARIANTS.find((v) => file.startsWith(`${v}-`));
  if (!variant) continue;
  /** suite -> identity -> passed, in this result file only. */
  const inFile = new Map();
  for (const row of readRows(join(resultsDir, file))) {
    const { suite, file: testFile, name, status: testStatus } = JSON.parse(row);
    const bySuite = inFile.get(suite) ?? new Map();
    const identity = JSON.stringify([testFile, name]);
    bySuite.set(identity, (bySuite.get(identity) ?? 0) + (testStatus === "passed" ? 1 : 0));
    inFile.set(suite, bySuite);
  }
  for (const [suite, bySuite] of inFile) {
    const merged = tests[variant].get(suite);
    if (!merged) {
      tests[variant].set(suite, bySuite);
      continue;
    }
    for (const [identity, passed] of bySuite) {
      merged.set(identity, Math.min(passed, merged.get(identity) ?? passed));
    }
  }
}

/**
 * Tests that pass on `baseline` and not on `branch`, as "<file> › <full name>" (with how many,
 * for a duplicated name); `null` when either has no per-test results for the suite (older result
 * files), so only the counts are compared.
 */
function lostTests(suite) {
  const baseline = tests.baseline.get(suite);
  const branch = tests.branch.get(suite);
  if (!baseline || !branch) return null;
  const lost = [];
  for (const [identity, passed] of baseline) {
    const missing = passed - (branch.get(identity) ?? 0);
    if (missing <= 0) continue;
    const [file, name] = JSON.parse(identity);
    lost.push(`${file} › ${JSON.stringify(name)}${missing > 1 ? ` (${missing} of them)` : ""}`);
  }
  return lost;
}

const branchRan = variants.branch.state === "ran";
const regressions = [];
const staleKnown = [];
const report = {};

for (const [suite, bySuite] of [...suites].sort(([a], [b]) => a.localeCompare(b))) {
  const status = (variant) =>
    variants[variant].state === "skipped" ? "not run" : (bySuite[variant]?.status ?? "missing");
  const baseline = status("baseline");
  const branch = status("branch");
  // A suite that fails on baseline still guards the tests it passes there.
  const baselinePassed = bySuite.baseline?.passed ?? 0;
  const lost = lostTests(suite) ?? [];
  // Fewer passed, or as many but not the same ones (one test newly fails while another is fixed).
  const fewerPassed =
    (baselinePassed > 0 && (bySuite.branch?.passed ?? 0) < baselinePassed) || lost.length > 0;
  let verdict;

  if (!branchRan) {
    verdict = "branch not run";
  } else if (branch === "pass" && !fewerPassed) {
    verdict = known.has(suite) ? "passes (remove from known-failures.txt)" : "ok";
    if (known.has(suite)) staleKnown.push(suite);
  } else if (baseline === "pass" || fewerPassed) {
    if (known.has(suite)) {
      const { reason, nextBug } = known.get(suite);
      verdict = `${nextBug ? "known Next bug" : "known failure"}${reason ? ` (${reason})` : ""}`;
    } else {
      verdict = "REGRESSION";
      regressions.push(suite);
    }
  } else if (baseline === "skipped" && branch === "skipped") {
    verdict = "skipped in deploy mode";
  } else {
    verdict = "no baseline pass";
  }

  report[suite] = { verdict, ...(lost.length > 0 ? { lostTests: lost } : {}) };
  for (const variant of VARIANTS) {
    report[suite][variant] = bySuite[variant] ?? { status: status(variant) };
  }
}

// A suite with no result on a variant that ran (a path in suites.txt that matched no files, or a
// suite no shard reported) could hide a regression, so it blocks like an unfinished shard.
const missingSuites = Object.entries(report).flatMap(([suite, row]) =>
  ["baseline", "branch"]
    .filter((variant) => row[variant].status === "missing")
    .map(
      (variant) => `${variant} ${suite}: no results (no test files matched, or no shard ran it)`,
    ),
);
const blockingIncomplete = branchRan
  ? [
      ...["baseline", "branch"].flatMap((v) =>
        variants[v].incomplete.map((item) => `${v} ${item}`),
      ),
      ...missingSuites,
    ]
  : [];

const totals = Object.fromEntries(
  VARIANTS.map((variant) => {
    const entries = Object.values(report).map((suite) => suite[variant]);
    const count = (s) => entries.filter((entry) => entry.status === s).length;
    const sum = (key) => entries.reduce((acc, entry) => acc + (entry[key] ?? 0), 0);
    return [
      variant,
      {
        state: variants[variant].state,
        ...(variants[variant].reason ? { reason: variants[variant].reason } : {}),
        incomplete: variants[variant].incomplete,
        suites: {
          pass: count("pass"),
          fail: count("fail"),
          timeout: count("timeout"),
          skipped: count("skipped"),
          missing: count("missing"),
        },
        tests: {
          passed: sum("passed"),
          failed: sum("failed"),
          skipped: sum("skipped"),
          total: sum("total"),
        },
      },
    ];
  }),
);

const minPassRate = Number(process.env.BASELINE_MIN_PASS_RATE ?? 0.5);
const baselineTests = totals.baseline.tests;
const baselineRan = baselineTests.passed + baselineTests.failed;
const baselinePassRate = baselineRan === 0 ? 0 : baselineTests.passed / baselineRan;
const percent = (rate, digits) => `${(rate * 100).toFixed(digits)}%`;
const harnessBroken =
  variants.baseline.state === "ran" && (baselineRan === 0 || baselinePassRate < minPassRate)
    ? `baseline passed ${baselineTests.passed} of the ${baselineRan} tests that ran (${percent(baselinePassRate, 1)}, minimum ${percent(minPassRate, 0)}); the harness is likely broken, so no comparison against it means anything`
    : null;

const runUrl = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : null;

const json = {
  schemaVersion: 1,
  nextjsRef: ref,
  generatedAt: new Date().toISOString(),
  run: runUrl,
  commit: process.env.GITHUB_SHA ?? null,
  options: {
    shards,
    useCache: process.env.NEXT_DEPLOY_USE_CACHE ?? "memory",
    instances: Number(process.env.NEXT_DEPLOY_INSTANCES ?? 2),
  },
  variants: totals,
  harnessBroken,
  regressions,
  knownFailures: Object.fromEntries(known),
  suites: report,
};

function cell(entry) {
  if (!entry || entry.total === undefined) return entry?.status ?? "-";
  if (entry.status === "skipped") {
    return entry.skipped ? `no tests ran (${entry.skipped} skipped)` : "no tests ran";
  }
  return `${entry.status} ${entry.passed}/${entry.total}${entry.failed ? ` (${entry.failed} failed)` : ""}`;
}

/** Notes of the handler variants; a note not shared by every variant that ran names its own. */
function notesCell(row) {
  const ran = HANDLER_VARIANTS.filter((variant) => variants[variant].state === "ran");
  const byNote = new Map();
  for (const variant of ran) {
    for (const note of row[variant].notes ?? []) {
      byNote.set(note, [...(byNote.get(note) ?? []), variant]);
    }
  }
  return [...byNote]
    .map(([note, on]) => (on.length === ran.length ? note : `${note} (${on.join(", ")})`))
    .join("; ");
}

const variantLine = (variant) => {
  const v = totals[variant];
  if (v.state === "skipped") return `- \`${variant}\`: skipped (${v.reason})`;
  return `- \`${variant}\`: ${v.suites.pass} suites pass, ${v.suites.fail + v.suites.timeout} fail, ${v.suites.skipped} ran no tests; tests ${v.tests.passed}/${v.tests.total} passed${v.incomplete.length ? `; incomplete: ${v.incomplete.join(", ")}` : ""}`;
};

const lines = [
  `## Next.js deploy tests (${ref})`,
  "",
  ...VARIANTS.map(variantLine),
  "",
  ...(harnessBroken ? [`**BROKEN HARNESS:** ${harnessBroken}.`, ""] : []),
  branchRan
    ? `**${regressions.length} regression(s)** of \`branch\` vs \`baseline\`${blockingIncomplete.length ? `, ${blockingIncomplete.length} incomplete` : ""}.`
    : "`branch` was not run, so there is no regression gate.",
  "",
  "Cells are `status passed/total`. `pkg-16.4.2` is informational.",
  "",
  `| Suite | ${VARIANTS.join(" | ")} | Verdict | Notes |`,
  `|---|${VARIANTS.map(() => "---|").join("")}---|---|`,
  ...Object.entries(report).map(([suite, row]) => {
    const verdict = row.verdict === "REGRESSION" ? "**REGRESSION**" : row.verdict;
    return `| \`${suite}\` | ${VARIANTS.map((v) => cell(row[v])).join(" | ")} | ${verdict} | ${notesCell(row)} |`;
  }),
  "",
];
if (blockingIncomplete.length > 0) {
  lines.push("### Incomplete", "", ...blockingIncomplete.map((item) => `- ${item}`), "");
}
const withLost = Object.entries(report).filter(([, row]) => row.lostTests);
if (withLost.length > 0) {
  lines.push(
    "### Tests that pass on `baseline` but not on `branch`",
    "",
    ...withLost.flatMap(([suite, row]) => [
      `- \`${suite}\`:`,
      ...row.lostTests.slice(0, 20).map((name) => `  - ${name}`),
      ...(row.lostTests.length > 20 ? [`  - ...and ${row.lostTests.length - 20} more`] : []),
    ]),
    "",
  );
}
if (staleKnown.length > 0) {
  lines.push("### Known failures that now pass", "", ...staleKnown.map((s) => `- \`${s}\``), "");
}
const markdown = lines.join("\n");

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${ref}.json`), `${JSON.stringify(json, null, 2)}\n`);
writeFileSync(join(outDir, `${ref}.md`), markdown);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}
console.log(markdown);

if (harnessBroken) {
  console.error(`::error::Broken harness: ${harnessBroken}`);
  process.exit(1);
}
if (regressions.length > 0 || blockingIncomplete.length > 0) {
  console.error(
    `::error::${regressions.length} regression(s), ${blockingIncomplete.length} incomplete result(s)`,
  );
  process.exit(1);
}
