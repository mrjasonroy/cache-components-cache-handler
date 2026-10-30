#!/usr/bin/env bash
set -u
mkdir -p artifacts
kubectl -n cache-e2e get pods -o wide > artifacts/pods.txt 2>&1
kubectl -n cache-e2e describe pods > artifacts/describe.txt 2>&1
kubectl -n cache-e2e get events --sort-by=.metadata.creationTimestamp > artifacts/events.txt 2>&1
for pod in $(kubectl -n cache-e2e get pods -o name); do
  kubectl -n cache-e2e logs "$pod" --all-containers > "artifacts/${pod#pod/}.log" 2>&1
  kubectl -n cache-e2e logs "$pod" --all-containers --previous > "artifacts/${pod#pod/}-previous.log" 2>&1 || true
done
kubectl -n cache-e2e exec deployment/redis -- redis-cli HGETALL multi-pod:tags > artifacts/redis-tags.txt 2>&1
kubectl -n cache-e2e exec deployment/redis -- redis-cli ZRANGE multi-pod:tag-index 0 -1 WITHSCORES > artifacts/redis-tag-index.txt 2>&1
