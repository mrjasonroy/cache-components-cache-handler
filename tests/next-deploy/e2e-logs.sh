#!/usr/bin/env bash
# Logs script for the deploy-mode harness (NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH). Runs in the test
# app dir after e2e-deploy.sh. The harness parses BUILD_ID / DEPLOYMENT_ID /
# NEXT_SUPPORTS_IMMUTABLE_ASSETS out of this output, which come from .deploy-build.log.
# It must exit 0.
for log in .deploy-build.log .deploy-server-*.log .deploy-proxy.log; do
  if [ -f "$log" ]; then
    echo "===== $log"
    cat "$log"
  fi
done
exit 0
