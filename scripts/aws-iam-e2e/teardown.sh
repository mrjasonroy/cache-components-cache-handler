#!/usr/bin/env bash
# Delete everything the cch-iam-e2e test infrastructure uses, in dependency order. Idempotent:
# anything already gone is skipped.
#
# The account and region come from the environment: AWS_PROFILE (or any other credentials the AWS
# CLI picks up) and AWS_REGION (else the profile's region). Resources are found by name and tag.
set -uo pipefail

export AWS_REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
[[ -n "$AWS_REGION" ]] || { echo "set AWS_REGION (and AWS_PROFILE for the account)" >&2; exit 2; }
export AWS_PAGER=""
NAME=cch-iam-e2e

log() { printf '[teardown] %s\n' "$*" >&2; }

# The runner's VPC, from its security group (looked up by name), before anything is deleted.
VPC_ID=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$NAME-runner" \
  --query 'SecurityGroups[0].VpcId' --output text 2>/dev/null)

# 1. Runner instance(s).
ids=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$NAME-runner" \
  "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text)
if [[ -n "$ids" && "$ids" != None ]]; then
  for id in $ids; do
    log "terminating $id"
    aws ec2 terminate-instances --instance-ids "$id" >/dev/null
    aws ec2 wait instance-terminated --instance-ids "$id"
  done
fi

# 2. Instance profile and role.
if aws iam get-instance-profile --instance-profile-name "$NAME-runner" >/dev/null 2>&1; then
  log "deleting instance profile"
  aws iam remove-role-from-instance-profile --instance-profile-name "$NAME-runner" \
    --role-name "$NAME-runner" 2>/dev/null
  aws iam delete-instance-profile --instance-profile-name "$NAME-runner"
fi
if aws iam get-role --role-name "$NAME-runner" >/dev/null 2>&1; then
  log "deleting role"
  aws iam delete-role-policy --role-name "$NAME-runner" --policy-name "$NAME-connect" 2>/dev/null
  aws iam detach-role-policy --role-name "$NAME-runner" \
    --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore 2>/dev/null
  aws iam delete-role --role-name "$NAME-runner"
fi

# 3. Serverless cache.
if aws elasticache describe-serverless-caches --serverless-cache-name "$NAME" >/dev/null 2>&1; then
  status=$(aws elasticache describe-serverless-caches --serverless-cache-name "$NAME" \
    --query 'ServerlessCaches[0].Status' --output text)
  if [[ "$status" != deleting ]]; then
    log "deleting serverless cache $NAME"
    aws elasticache delete-serverless-cache --serverless-cache-name "$NAME" >/dev/null
  fi
  log "waiting for the cache to go"
  while aws elasticache describe-serverless-caches --serverless-cache-name "$NAME" >/dev/null 2>&1; do
    sleep 20
  done
fi

# 4. User group, then user.
if aws elasticache describe-user-groups --user-group-id "$NAME-group" >/dev/null 2>&1; then
  log "deleting user group"
  for _ in $(seq 1 30); do
    aws elasticache delete-user-group --user-group-id "$NAME-group" >/dev/null 2>&1 && break
    sleep 10
  done
  while aws elasticache describe-user-groups --user-group-id "$NAME-group" >/dev/null 2>&1; do
    sleep 10
  done
fi
if aws elasticache describe-users --user-id "$NAME-user" >/dev/null 2>&1; then
  log "deleting user"
  aws elasticache delete-user --user-id "$NAME-user" >/dev/null
fi

# 5. Security groups (cache SG references the runner SG, so it goes first). The cache's ENIs can
# linger for a few minutes after it is deleted.
for sg_name in "$NAME-cache" "$NAME-runner"; do
  filters=("Name=group-name,Values=$sg_name")
  [[ "$VPC_ID" == vpc-* ]] && filters+=("Name=vpc-id,Values=$VPC_ID")
  sg=$(aws ec2 describe-security-groups --filters "${filters[@]}" \
    --query 'SecurityGroups[0].GroupId' --output text)
  [[ "$sg" == sg-* ]] || continue
  log "deleting security group $sg_name ($sg)"
  for _ in $(seq 1 30); do
    aws ec2 delete-security-group --group-id "$sg" 2>/dev/null && break
    sleep 20
  done
done

log "done"
