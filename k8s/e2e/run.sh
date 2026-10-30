#!/usr/bin/env bash
set -euo pipefail
kubectl apply -f k8s/e2e/cluster.yaml
kubectl -n cache-e2e create secret generic revalidate --from-literal=token="$(openssl rand -hex 24)"
kubectl -n cache-e2e rollout status deployment/redis --timeout=90s
kubectl -n cache-e2e rollout status deployment/app --timeout=90s
# Individual Pod IPs, not port-forwarding a Service (which pins one backend).
pods=$(kubectl -n cache-e2e get endpoints app -o json | node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const addresses = JSON.parse(input).subsets.flatMap(s => s.addresses ?? []);
  if (addresses.length !== 3) process.exit(1);
  process.stdout.write(addresses.map(a => `http://${a.ip}:3000`).join(","));
});')
kubectl -n cache-e2e create configmap pods --from-literal=urls="$pods"
kubectl apply -f k8s/e2e/job.yaml
for _ in $(seq 1 180); do
  status=$(kubectl -n cache-e2e get job driver -o jsonpath='{.status.succeeded},{.status.failed}')
  case "$status" in
    1,*) kubectl -n cache-e2e logs job/driver; exit 0 ;;
    *,1) kubectl -n cache-e2e logs job/driver; exit 1 ;;
  esac
  sleep 1
done
kubectl -n cache-e2e logs job/driver || true
echo 'Driver did not finish in 180 seconds' >&2
exit 1
