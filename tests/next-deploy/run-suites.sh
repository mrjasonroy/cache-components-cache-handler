#!/usr/bin/env bash
# Runs this shard's share of suites.txt through vercel/next.js's run-tests.js in deploy mode.
#
#   run-suites.sh <baseline|pkg-16.5.1|branch> <shard> <shards>
#
# Needs NEXT_REPO_DIR (a built vercel/next.js checkout) and RESULTS_DIR. Optional: SUITE_FILTER
# (extended regex over suites.txt lines), SUITE_TIMEOUT (seconds, default 2400), RETRIES
# (default 1), CONCURRENCY (default 2), NEXT_DEPLOY_SKIP_REASON (record the whole variant as
# skipped without running anything, e.g. branch before withCache exists).
#
# Test files are dealt round-robin across shards, so a big suite (cache-components has 13
# files) spreads out. Each shard writes RESULTS_DIR/<variant>-<shard>.tsv with one row per suite
# part (suite, status, seconds, files, passed, failed, skipped, total) and a final "#complete"
# row, plus a log per suite part. Test counts come from the jest JSON that run-tests.js prints
# into that log for each test file (see count-results.mjs). The last 200 lines of every server
# and proxy log of a part that did not pass are kept under RESULTS_DIR/server-logs/ (see
# e2e-cleanup.sh). A failing suite never fails this script; report.mjs decides.
set -uo pipefail

VARIANT="$1"
SHARD="$2"
SHARDS="$3"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${NEXT_REPO_DIR:?NEXT_REPO_DIR must point at the vercel/next.js checkout}"
: "${RESULTS_DIR:?RESULTS_DIR is required}"

mkdir -p "$RESULTS_DIR/logs"
RESULTS="$RESULTS_DIR/$VARIANT-$SHARD.tsv"
: >"$RESULTS"
# One row per test, by name (count-results.mjs), for report.mjs's per-test comparison.
TESTS="$RESULTS_DIR/$VARIANT-$SHARD.tests.jsonl"
: >"$TESTS"

if [ -n "${NEXT_DEPLOY_SKIP_REASON:-}" ]; then
  echo "$VARIANT skipped: $NEXT_DEPLOY_SKIP_REASON"
  printf '#skipped\t%s\n#complete\n' "$NEXT_DEPLOY_SKIP_REASON" >>"$RESULTS"
  exit 0
fi

export NEXT_DEPLOY_VARIANT="$VARIANT"
export NEXT_DEPLOY_NOTES_FILE="$RESULTS_DIR/$VARIANT-$SHARD.notes.tsv"
: >"$NEXT_DEPLOY_NOTES_FILE"
SERVER_LOGS_ROOT="$RESULTS_DIR/server-logs/$VARIANT-shard$SHARD"

# e2e-deploy.sh records every server/proxy process group here too, so anything the harness's
# cleanup missed (a timed-out suite, a killed jest worker) is stopped before the next suite part
# instead of piling up on the runner.
export NEXT_DEPLOY_PIDS_FILE="$RESULTS_DIR/.$VARIANT-$SHARD.pids"
: >"$NEXT_DEPLOY_PIDS_FILE"
stop_leftover_servers() {
  local pid
  while read -r pid; do
    [ -n "$pid" ] || continue
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  done <"$NEXT_DEPLOY_PIDS_FILE"
  : >"$NEXT_DEPLOY_PIDS_FILE"
}
trap stop_leftover_servers EXIT

# Harness settings, as in https://nextjs.org/docs/app/api-reference/adapters/testing-adapters
export NEXT_TEST_MODE=deploy
export NEXT_TEST_JOB=1
# Makes run-tests.js print every test file's jest JSON into the log, not only the failed ones'.
# count-results.mjs reads the counts from there.
export NEXT_TEST_EMIT_ALL_OUTPUT=1
# run-tests.js's passed-test cache keys on GITHUB_SHA; on a re-run attempt it would skip tests that
# passed before and report them as never run.
export NEXT_TEST_SKIP_RESULT_CACHE=1
export IS_TURBOPACK_TEST=1
export NEXT_TELEMETRY_DISABLED=1
export NEXT_E2E_TEST_TIMEOUT=240000
export NEXT_EXTERNAL_TESTS_FILTERS=test/deploy-tests-manifest.json
export NEXT_TEST_DEPLOY_SCRIPT_PATH="$HERE/e2e-deploy.sh"
export NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH="$HERE/e2e-logs.sh"
export NEXT_TEST_CLEANUP_SCRIPT_PATH="$HERE/e2e-cleanup.sh"

mapfile -t suites < <(grep -vE '^\s*(#|$)' "$HERE/suites.txt")

# Deal every test file to a shard, keeping the order of suites.txt.
declare -A shard_files=()
suite_order=()
index=0
for suite in "${suites[@]}"; do
  if [ -n "${SUITE_FILTER:-}" ] && ! [[ "$suite" =~ $SUITE_FILTER ]]; then
    continue
  fi
  if [[ "$suite" =~ \.test\.(ts|tsx|js)$ ]]; then
    files=("$suite")
  else
    mapfile -t files < <(cd "$NEXT_REPO_DIR" && find "$suite" -path '*/node_modules' -prune -o \
      -type f \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.js' \) -print | sort)
  fi
  if [ "${#files[@]}" -eq 0 ]; then
    # Only shard 1 reports a suite that matched no files, so it is counted once.
    if [ "$SHARD" = "1" ]; then
      printf '%s\tmissing\t0\t0\n' "$suite" >>"$RESULTS"
    fi
    continue
  fi
  for file in "${files[@]}"; do
    if [ $((index % SHARDS + 1)) = "$SHARD" ]; then
      if [ -z "${shard_files[$suite]+set}" ]; then
        suite_order+=("$suite")
        shard_files[$suite]=""
      fi
      shard_files[$suite]+="$file"$'\n'
    fi
    index=$((index + 1))
  done
done

for suite in "${suite_order[@]}"; do
  mapfile -t files < <(printf '%s' "${shard_files[$suite]}")
  log="$RESULTS_DIR/logs/$VARIANT-${suite//\//_}-shard$SHARD.log"
  export NEXT_DEPLOY_CURRENT_SUITE="$suite"
  export NEXT_DEPLOY_SERVER_LOGS_DIR="$SERVER_LOGS_ROOT/${suite//\//_}"
  for file in "${files[@]}"; do
    rm -f "$NEXT_REPO_DIR/$file.results.json"
  done

  echo "::group::$VARIANT $suite (${#files[@]} files)"
  started=$SECONDS
  (
    cd "$NEXT_REPO_DIR" &&
      timeout --kill-after=60 "${SUITE_TIMEOUT:-2400}" node run-tests.js --type e2e \
        -c "${CONCURRENCY:-2}" --retries "${RETRIES:-1}" "${files[@]}"
  ) >"$log" 2>&1
  code=$?
  elapsed=$((SECONDS - started))
  stop_leftover_servers

  # passed, failed, skipped, total (and test files without results) for this part.
  counts="$(cd "$NEXT_REPO_DIR" && COUNT_RESULTS_TESTS_FILE="$TESTS" COUNT_RESULTS_SUITE="$suite" \
    node "$HERE/count-results.mjs" "$log" "${files[@]}")"
  IFS=$'\t' read -r passed failed skipped total unknown <<<"$counts"
  counts="$passed"$'\t'"$failed"$'\t'"$skipped"$'\t'"$total"

  # "pass" means at least one test passed and none failed. A clean exit with nothing passed or
  # failed is "skipped": the files are gated off in deploy mode (@force-gate !deploy,
  # describe.skip) or the manifest filtered them out.
  if [ "$code" = 124 ] || [ "$code" = 137 ]; then
    status=timeout
  elif [ "$code" != 0 ] || [ "${failed:-0}" -gt 0 ]; then
    status=fail
  elif [ "${passed:-0}" -gt 0 ]; then
    status=pass
  else
    status=skipped
  fi
  if [ "$status" = fail ] || [ "$status" = timeout ]; then
    tail -n 150 "$log"
  else
    # Server logs are kept only for parts worth triaging.
    rm -rf "$NEXT_DEPLOY_SERVER_LOGS_DIR"
  fi
  echo "::endgroup::"
  if [ "${unknown:-0}" -gt 0 ]; then
    echo "::warning::$VARIANT $suite: no jest results for $unknown of ${#files[@]} test files; counts are partial"
  fi

  echo "$VARIANT $suite: $status (${elapsed}s; passed/failed/skipped/total: ${counts//$'\t'//})"
  printf '%s\t%s\t%s\t%s\t%s\n' "$suite" "$status" "$elapsed" "${#files[@]}" "$counts" >>"$RESULTS"
done

printf '#complete\n' >>"$RESULTS"
