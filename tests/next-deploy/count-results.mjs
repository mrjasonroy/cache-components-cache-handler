#!/usr/bin/env node
// Sums the jest results of one suite part from its run-tests.js log.
//
//   node count-results.mjs <log> <testFile> [<testFile> ...]
//
// Prints "passed\tfailed\tskipped\ttotal\tunknown" (unknown = test files with no results).
// With COUNT_RESULTS_TESTS_FILE and COUNT_RESULTS_SUITE set, it also appends one JSON line per
// test, {"suite","file","name","status"} (the exact jest full name; jest's status: passed, failed,
// pending...), to that file, so report.mjs can compare tests by name and not only by count.
//
// run-tests.js (v16.4.2, the loop in runTest) prints each test file's jest JSON once, after its
// last attempt, as one line `--test output start-- {json} --test output end--`. It does that for
// failed files, and for every file when NEXT_TEST_EMIT_ALL_OUTPUT is set, which run-suites.sh
// sets. The log is the source because the <file>.results.json files are not reliable: before a
// retry run-tests.js runs `git clean -fdx <suite dir>`, which deletes the results of every other
// file in that directory too. A file with no block in the log falls back to its .results.json
// (relative to the cwd, the next.js checkout). When a file has several blocks the last one wins.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const START = "--test output start--";
const END = "--test output end--";

const [logFile, ...testFiles] = process.argv.slice(2);
if (!logFile || testFiles.length === 0) {
  console.error("usage: count-results.mjs <log> <testFile> [<testFile> ...]");
  process.exit(2);
}

/** testFile -> jest JSON */
const results = new Map();

/** Which of testFiles a jest JSON is for: testResults[].name is the absolute path. */
function fileOf(result) {
  for (const { name } of result.testResults ?? []) {
    const match = testFiles.find((file) => name === file || name?.endsWith(`/${file}`));
    if (match) return match;
  }
  return null;
}

const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
for (const line of log.split("\n")) {
  const start = line.indexOf(START);
  const end = line.lastIndexOf(END);
  if (start === -1 || end <= start) continue;
  let result;
  try {
    result = JSON.parse(line.slice(start + START.length, end));
  } catch {
    continue;
  }
  const file = fileOf(result);
  if (file) results.set(file, result);
}

for (const file of testFiles) {
  if (results.has(file) || !existsSync(`${file}.results.json`)) continue;
  try {
    results.set(file, JSON.parse(readFileSync(`${file}.results.json`, "utf8")));
  } catch {
    // counted as unknown below
  }
}

const sum = [0, 0, 0, 0, 0];
for (const file of testFiles) {
  const r = results.get(file);
  if (!r) {
    sum[4] += 1;
    continue;
  }
  sum[0] += r.numPassedTests ?? 0;
  sum[1] += r.numFailedTests ?? 0;
  sum[2] += (r.numPendingTests ?? 0) + (r.numTodoTests ?? 0);
  sum[3] += r.numTotalTests ?? 0;
}
const testsFile = process.env.COUNT_RESULTS_TESTS_FILE;
const suite = process.env.COUNT_RESULTS_SUITE;
if (testsFile && suite) {
  const rows = [];
  for (const file of testFiles) {
    for (const { assertionResults = [] } of results.get(file)?.testResults ?? []) {
      for (const { fullName, title, status } of assertionResults) {
        const name = fullName ?? title ?? "";
        rows.push(`${JSON.stringify({ suite, file, name, status })}\n`);
      }
    }
  }
  if (rows.length > 0) appendFileSync(testsFile, rows.join(""));
}
console.log(sum.join("\t"));
