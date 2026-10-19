#!/usr/bin/env bash
# Cleanup script for the deploy-mode harness (NEXT_TEST_CLEANUP_SCRIPT_PATH). Runs in the test
# app dir when the suite tears down: stops the `next start` processes and the proxy that
# e2e-deploy.sh started (each in its own process group).
if [ -f .deploy-pids ]; then
  while read -r pid; do
    [ -n "$pid" ] || continue
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done <.deploy-pids
  rm -f .deploy-pids
fi
exit 0
