#!/usr/bin/env bash
# Deploy script for Next.js's deploy-mode test harness (NEXT_TEST_DEPLOY_SCRIPT_PATH).
#
# The harness runs it with cwd = the isolated test app (also in NEXT_TEST_DIR), and reads the
# deployment URL from stdout: stdout must be exactly the URL, so everything else goes to stderr.
# State for e2e-logs.sh / e2e-cleanup.sh is left in files in the app dir (separate processes).
#
# NEXT_DEPLOY_VARIANT=baseline    plain `next build` + one `next start`, nothing injected. One
#                                 instance, because without a shared cache two instances would
#                                 fail cache tests for reasons that have nothing to do with us.
# NEXT_DEPLOY_VARIANT=pkg-16.4.2  the published 16.4.2 from npm, wired the 16.4.2 way.
# NEXT_DEPLOY_VARIANT=branch      this branch's packed package, wired with withCache.
# Both handler variants run NEXT_DEPLOY_INSTANCES (default 2) `next start` processes on one Redis
# behind proxy.mjs. A fixture that keeps its own cacheHandler/cacheHandlers gets one instance:
# its handler stores entries in process memory, which round-robin would split, and Next makes no
# cross-instance promise for such a handler.
set -euo pipefail

# Keep fd 3 for the URL; send all other output to stderr.
exec 3>&1 1>&2

# Jest (which runs the harness) sets NODE_ENV=test; next build/start must pick their own.
unset NODE_ENV

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VARIANT="${NEXT_DEPLOY_VARIANT:-baseline}"
APP_DIR="$PWD"
SUITE="${NEXT_DEPLOY_CURRENT_SUITE:-unknown}"

case "$VARIANT" in
  baseline) INSTANCES=1 ;;
  pkg-16.4.2 | branch) INSTANCES="${NEXT_DEPLOY_INSTANCES:-2}" ;;
  *)
    echo "[next-deploy] unknown NEXT_DEPLOY_VARIANT: $VARIANT" >&2
    exit 2
    ;;
esac

free_port() {
  node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });'
}

wait_for_port() {
  local port="$1" log="$2"
  for _ in $(seq 1 120); do
    # Any HTTP status means the server is up; 000 means nothing answered yet.
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/" || true)" != "000" ]; then
      return 0
    fi
    sleep 1
  done
  echo "[next-deploy] nothing listening on :$port after 120s" >&2
  tail -n 100 "$log" >&2 || true
  return 1
}

# Starts a command in its own session (so e2e-cleanup.sh can kill the whole process group) with
# its output in a log file, never on this script's stdout.
#
# `3>&-` matters: fd 3 is the harness's stdout pipe, and execa only resolves once every holder of
# that pipe has closed it. A server that inherits fd 3 keeps the deploy "running" until jest's
# 240s beforeAll timeout, so every test fails without a request ever being made.
start_background() {
  local log="$1"
  shift
  setsid nohup "$@" >"$log" 2>&1 </dev/null 3>&- &
  echo "$!" >>.deploy-pids
  if [ -n "${NEXT_DEPLOY_PIDS_FILE:-}" ]; then
    echo "$!" >>"$NEXT_DEPLOY_PIDS_FILE"
  fi
}

echo "[next-deploy] suite=$SUITE variant=$VARIANT instances=$INSTANCES app=$APP_DIR"
: >.deploy-pids

if [ "$VARIANT" != "baseline" ]; then
  : "${NEXT_DEPLOY_REDIS_URL:?NEXT_DEPLOY_REDIS_URL must point at the job Redis}"
  if [ "$VARIANT" = "branch" ]; then
    : "${CACHE_HANDLER_TARBALL:?CACHE_HANDLER_TARBALL must point at the packed package}"
    node "$HERE/inject-handlers.mjs" "$APP_DIR" branch "$CACHE_HANDLER_TARBALL"
  else
    node "$HERE/inject-handlers.mjs" "$APP_DIR" pkg-16.4.2
  fi
  export REDIS_URL="$NEXT_DEPLOY_REDIS_URL"
  # One Redis serves every deployment in the job, possibly two at once (-c 2). A prefix per
  # deployment keeps their tag records apart.
  CACHE_KEY_PREFIX="nd-$(node -e 'console.log(require("node:crypto").randomBytes(6).toString("hex"))'):"
  export CACHE_KEY_PREFIX
  echo "CACHE_KEY_PREFIX=$CACHE_KEY_PREFIX" >.deploy-env
fi

# Like Next's own create-next-install: the package's `next` peer pins one minor (~16.4.0), and a
# dispatch may test it against another Next (a 16.5 canary); that must stay a warning here.
pnpm install --strict-peer-dependencies=false --no-frozen-lockfile --prefer-offline

# The harness's `build` script is `<fixture build or next build> && pnpm post-build`, and
# post-build prints the BUILD_ID / DEPLOYMENT_ID / NEXT_SUPPORTS_IMMUTABLE_ASSETS lines that
# the harness parses out of e2e-logs.sh.
pnpm build 2>&1 | tee .deploy-build.log

if ! grep -q "NEXT_SUPPORTS_IMMUTABLE_ASSETS:" .deploy-build.log; then
  build_id="$(cat .next/BUILD_ID)"
  {
    echo "BUILD_ID: $build_id"
    echo "DEPLOYMENT_ID: local-$build_id"
    echo "NEXT_SUPPORTS_IMMUTABLE_ASSETS: 0"
  } >>.deploy-build.log
fi

if [ "$INSTANCES" -gt 1 ] && [ "$(cat .handler-instances 2>/dev/null)" = "1" ]; then
  INSTANCES=1
  echo "[next-deploy] the fixture's own cache handler is in the config; running one instance"
  printf '%s1 instance (fixture handler is per-process)' "$([ -s .handler-notes ] && echo '; ')" \
    >>.handler-notes
fi

if [ -n "${NEXT_DEPLOY_NOTES_FILE:-}" ] && [ -s .handler-notes ]; then
  printf '%s\t%s\n' "$SUITE" "$(cat .handler-notes)" >>"$NEXT_DEPLOY_NOTES_FILE"
fi

ports=()
for n in $(seq 1 "$INSTANCES"); do
  port="$(free_port)"
  start_background ".deploy-server-$n.log" ./node_modules/.bin/next start -p "$port"
  ports+=("$port")
done

for n in $(seq 1 "$INSTANCES"); do
  wait_for_port "${ports[$((n - 1))]}" ".deploy-server-$n.log"
done

if [ "$INSTANCES" -gt 1 ]; then
  url_port="$(free_port)"
  start_background .deploy-proxy.log node "$HERE/proxy.mjs" "$url_port" "${ports[@]}"
  wait_for_port "$url_port" .deploy-proxy.log
else
  url_port="${ports[0]}"
fi

echo "[next-deploy] ready on :$url_port (instances: ${ports[*]})"
echo "http://localhost:$url_port" >&3
