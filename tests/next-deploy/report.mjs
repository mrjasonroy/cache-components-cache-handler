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
//   - a suite passes on `baseline` and does not pass on `branch` (not in known-failures.txt), or
//   - `baseline` or `branch` results are incomplete (a shard never finished), since a missing
//     result can hide a regression.
// `pkg-16.5.1` is informational. A skipped `branch` (no withCache yet) never fails the job.
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
const VARIANTS = ["baseline", "pkg-16.5.1", "branch"];
// Worst part wins; "skipped" only when every part was skipped (the deploy manifest drops files).
const RANK = { skipped: 0, pass: 1, missing: 2, timeout: 3, fail: 4 };

function readRows(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

const known = new Set(
  existsSync(knownFailuresFile)
    ? readRows(knownFailuresFile)
        .filter((line) => !line.startsWith("#"))
        .map((line) => line.trim().split(/\s+/)[0])
    : [],
);

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
      if (!previous || RANK[status] > RANK[merged.status]) {
        merged.status = status in RANK ? status : "fail";
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

const branchRan = variants.branch.state === "ran";
const regressions = [];
const staleKnown = [];
const report = {};

for (const [suite, bySuite] of [...suites].sort(([a], [b]) => a.localeCompare(b))) {
  const status = (variant) =>
    variants[variant].state === "skipped" ? "not run" : (bySuite[variant]?.status ?? "missing");
  const baseline = status("baseline");
  const branch = status("branch");
  let verdict;

  if (!branchRan) {
    verdict = "branch not run";
  } else if (branch === "pass") {
    verdict = known.has(suite) ? "passes (remove from known-failures.txt)" : "ok";
    if (known.has(suite)) staleKnown.push(suite);
  } else if (baseline === "pass") {
    if (known.has(suite)) {
      verdict = "known failure";
    } else {
      verdict = "REGRESSION";
      regressions.push(suite);
    }
  } else if (baseline === "skipped" && branch === "skipped") {
    verdict = "skipped in deploy mode";
  } else {
    verdict = "no baseline pass";
  }

  report[suite] = { verdict };
  for (const variant of VARIANTS) {
    report[suite][variant] = bySuite[variant] ?? { status: status(variant) };
  }
}

const blockingIncomplete = branchRan
  ? ["baseline", "branch"].flatMap((v) => variants[v].incomplete.map((item) => `${v} ${item}`))
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
  regressions,
  knownFailures: [...known],
  suites: report,
};

function cell(entry) {
  if (!entry || entry.total === undefined) return entry?.status ?? "-";
  return `${entry.status} ${entry.passed}/${entry.total}${entry.failed ? ` (${entry.failed} failed)` : ""}`;
}

const variantLine = (variant) => {
  const v = totals[variant];
  if (v.state === "skipped") return `- \`${variant}\`: skipped (${v.reason})`;
  return `- \`${variant}\`: ${v.suites.pass} suites pass, ${v.suites.fail + v.suites.timeout} fail; tests ${v.tests.passed}/${v.tests.total} passed${v.incomplete.length ? `; incomplete: ${v.incomplete.join(", ")}` : ""}`;
};

const lines = [
  `## Next.js deploy tests (${ref})`,
  "",
  ...VARIANTS.map(variantLine),
  "",
  branchRan
    ? `**${regressions.length} regression(s)** of \`branch\` vs \`baseline\`${blockingIncomplete.length ? `, ${blockingIncomplete.length} incomplete` : ""}.`
    : "`branch` was not run, so nothing is gated.",
  "",
  "Cells are `status passed/total`. `pkg-16.5.1` is informational.",
  "",
  "| Suite | baseline | pkg-16.5.1 | branch | Verdict | Notes |",
  "|---|---|---|---|---|---|",
  ...Object.entries(report).map(([suite, row]) => {
    const notes = [...new Set([...(row["pkg-16.5.1"].notes ?? []), ...(row.branch.notes ?? [])])];
    const verdict = row.verdict === "REGRESSION" ? "**REGRESSION**" : row.verdict;
    return `| \`${suite}\` | ${cell(row.baseline)} | ${cell(row["pkg-16.5.1"])} | ${cell(row.branch)} | ${verdict} | ${notes.join("; ")} |`;
  }),
  "",
];
if (blockingIncomplete.length > 0) {
  lines.push("### Incomplete", "", ...blockingIncomplete.map((item) => `- ${item}`), "");
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

if (regressions.length > 0 || blockingIncomplete.length > 0) {
  console.error(
    `::error::${regressions.length} regression(s), ${blockingIncomplete.length} incomplete result(s)`,
  );
  process.exit(1);
}
