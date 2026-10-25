#!/usr/bin/env bash
# Run the ElastiCache IAM-auth e2e test on the cch-iam-e2e runner (EC2 in the cache's VPC).
#
#   scripts/aws-iam-e2e/run.sh <git-ref>      e.g. origin/feat/elasticache-iam, a SHA, or pr/84
#
# Starts the runner, waits for SSM, clones the repo at <git-ref>, installs, builds, runs
# src/integration/elasticache-iam against the serverless cache, prints the output, and always
# stops the instance again. Exit code = the remote test exit code.
#
# The account and region come from the environment: AWS_PROFILE (or any other credentials the AWS
# CLI picks up) and AWS_REGION (else the profile's region). The instance, cache and endpoint are
# looked up by name at run time. Overrides: CCH_INSTANCE_NAME (cch-iam-e2e-runner, the instance's
# Name tag), CCH_CACHE_NAME (cch-iam-e2e), CCH_IAM_USER (cch-iam-e2e-user), CCH_REPO_URL,
# CCH_TIMEOUT_SECONDS (1800).
set -euo pipefail

REF="${1:?usage: run.sh <git-ref>}"
export AWS_REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
[[ -n "$AWS_REGION" ]] || { echo "set AWS_REGION (and AWS_PROFILE for the account)" >&2; exit 2; }
export AWS_PAGER=""
INSTANCE_NAME="${CCH_INSTANCE_NAME:-cch-iam-e2e-runner}"
CACHE_NAME="${CCH_CACHE_NAME:-cch-iam-e2e}"
IAM_USER="${CCH_IAM_USER:-cch-iam-e2e-user}"
REPO_URL="${CCH_REPO_URL:-https://github.com/mrjasonroy/cache-components-cache-handler}"
TIMEOUT="${CCH_TIMEOUT_SECONDS:-1800}"

# Everything below is pasted into a script that runs as root on the runner: allow only characters
# that cannot break out of its quoting.
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "invalid ref: $REF" >&2; exit 2; }
[[ "$REPO_URL" =~ ^https://[A-Za-z0-9._/-]+$ ]] || { echo "invalid repo url: $REPO_URL" >&2; exit 2; }
[[ "$CACHE_NAME" =~ ^[A-Za-z0-9-]+$ && "$IAM_USER" =~ ^[A-Za-z0-9-]+$ ]] ||
  { echo "invalid cache name or IAM user" >&2; exit 2; }
[[ "$AWS_REGION" =~ ^[a-z0-9-]+$ && "$TIMEOUT" =~ ^[0-9]+$ ]] ||
  { echo "invalid region or timeout" >&2; exit 2; }

log() { printf '[run.sh] %s\n' "$*" >&2; }

INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=$INSTANCE_NAME" \
  "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
[[ "$INSTANCE_ID" == i-* ]] || { log "no instance named $INSTANCE_NAME"; exit 2; }

ENDPOINT=$(aws elasticache describe-serverless-caches --serverless-cache-name "$CACHE_NAME" \
  --query 'ServerlessCaches[0].Endpoint.Address' --output text)
[[ "$ENDPOINT" =~ ^[A-Za-z0-9.-]+\.amazonaws\.com$ ]] || { log "no endpoint for $CACHE_NAME"; exit 2; }

stop_instance() {
  log "stopping $INSTANCE_ID"
  aws ec2 stop-instances --instance-ids "$INSTANCE_ID" >/dev/null || log "WARNING: stop failed"
}
trap stop_instance EXIT

log "waiting for $INSTANCE_ID to be stoppable/startable"
state=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].State.Name' --output text)
[[ "$state" == stopping ]] && aws ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"
log "starting $INSTANCE_ID"
aws ec2 start-instances --instance-ids "$INSTANCE_ID" >/dev/null
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"

log "waiting for SSM"
for _ in $(seq 1 60); do
  ping=$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
    --query 'InstanceInformationList[0].PingStatus' --output text)
  [[ "$ping" == Online ]] && break
  sleep 10
done
[[ "$ping" == Online ]] || { log "SSM agent never came online"; exit 3; }
# SSM reports Online from the previous boot for a little while; give the agent a moment.
sleep 15

# The remote script. Everything goes to a log; stdout gets its tail, since SSM keeps only the
# first 24,000 characters of a command's output.
REMOTE=$(cat <<EOF
#!/bin/bash
export HOME=/root COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
LOG=/var/log/cch-run.log
(
  set -euxo pipefail
  rm -rf /opt/cch-run
  git clone --quiet "$REPO_URL" /opt/cch-run
  cd /opt/cch-run
  git fetch --quiet origin '+refs/pull/*/head:refs/remotes/origin/pr/*'
  git checkout --quiet "$REF"
  git log -1 --oneline
  pnpm install --frozen-lockfile --reporter=append-only
  pnpm --filter @mrjasonroy/cache-components-cache-handler build
  ELASTICACHE_IAM_E2E=1 ELASTICACHE_ENDPOINT="$ENDPOINT" ELASTICACHE_IAM_USER="$IAM_USER" \\
  ELASTICACHE_CACHE_NAME="$CACHE_NAME" ELASTICACHE_REGION="$AWS_REGION" ELASTICACHE_SERVERLESS=1 \\
    pnpm --filter @mrjasonroy/cache-components-cache-handler exec vitest run src/integration/elasticache-iam
) > "\$LOG" 2>&1
rc=\$?
tail -c 22000 "\$LOG"
echo "[remote] exit \$rc"
exit \$rc
EOF
)
B64=$(printf '%s' "$REMOTE" | base64 | tr -d '\n')
PARAMS=$(jq -n --arg cmd "echo $B64 | base64 -d > /tmp/cch-run.sh && bash /tmp/cch-run.sh" \
  --arg t "$TIMEOUT" '{commands: [$cmd], executionTimeout: [$t]}')

log "sending test command (ref $REF, timeout ${TIMEOUT}s)"
CMD_ID=$(aws ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
  --comment "cch-iam-e2e $REF" --parameters "$PARAMS" --query Command.CommandId --output text)

status=Pending
failures=0
while [[ "$status" == Pending || "$status" == InProgress || "$status" == Delayed ]]; do
  sleep 15
  # A failed describe (the invocation not registered yet, a throttle) is retried; several in a row
  # (expired credentials) end the run rather than polling forever.
  if next=$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
    --query Status --output text 2>/dev/null); then
    status=$next
    failures=0
  else
    failures=$((failures + 1))
    if ((failures >= 8)); then
      log "could not read the command's status $failures times in a row (expired credentials?)"
      exit 4
    fi
  fi
  log "status: $status"
done

aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
  --query StandardOutputContent --output text
err=$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
  --query StandardErrorContent --output text)
[[ -n "$err" && "$err" != None ]] && printf '%s\n' "$err" >&2
rc=$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
  --query ResponseCode --output text)
log "remote status $status, exit code $rc"
[[ "$rc" =~ ^-?[0-9]+$ && "$rc" -ge 0 ]] || rc=1
exit "$rc"
