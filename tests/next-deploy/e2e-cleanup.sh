#!/usr/bin/env bash
# Cleanup script for the deploy-mode harness (NEXT_TEST_CLEANUP_SCRIPT_PATH). Runs in the test
# app dir when the suite tears down: stops the `next start` processes and the proxy that
# e2e-deploy.sh started (each in its own process group).
#
# First it prints the last 200 lines of each server and proxy log to stderr, so a runtime error
# (a 500 from a handler) shows in the suite log next to the failing test. This script's stderr
# goes to the jest worker's (next-deploy.ts runs it with stderr: "inherit"), which jest may not
# pass on, so the same tails are also copied to
# NEXT_DEPLOY_SERVER_LOGS_DIR/<app dir>/ (set by run-suites.sh, which keeps them only for suite
# parts that did not pass).
copy_dir=""
if [ -n "${NEXT_DEPLOY_SERVER_LOGS_DIR:-}" ]; then
  copy_dir="$NEXT_DEPLOY_SERVER_LOGS_DIR/$(basename "$PWD")"
  mkdir -p "$copy_dir" 2>/dev/null || copy_dir=""
fi
for log in .deploy-server-*.log .deploy-proxy.log; do
  [ -f "$log" ] || continue
  {
    echo "===== [next-deploy] last 200 lines of $log ($PWD)"
    tail -n 200 "$log"
    echo "===== [next-deploy] end of $log"
  } >&2
  if [ -n "$copy_dir" ]; then
    tail -n 200 "$log" >"$copy_dir/${log#.}" 2>/dev/null || true
  fi
done

if [ -f .deploy-pids ]; then
  while read -r pid; do
    [ -n "$pid" ] || continue
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done <.deploy-pids
  rm -f .deploy-pids
fi
exit 0
