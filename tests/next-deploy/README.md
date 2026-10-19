# Next.js deploy-mode tests

This runs Next.js's own caching e2e suites against apps wired with this package, using the
harness that Next.js provides for deployment adapters
([Testing adapters](https://nextjs.org/docs/app/api-reference/adapters/testing-adapters)).
The harness is `run-tests.js` with `NEXT_TEST_MODE=deploy`, and `e2e-deploy.sh` is the deploy
script.

Every suite in `suites.txt` runs in three variants:

| Variant | What `e2e-deploy.sh` does |
|---|---|
| `baseline` | Runs plain `pnpm build` (the fixture's `next build`), then one `next start`. No custom handlers. |
| `pkg-16.5.1` | Installs the **published** `@mrjasonroy/cache-components-cache-handler@16.5.1` from npm and wires it the 16.5.1 way: `createCacheConfig` plus a generated `data-cache-handler.mjs` that exports `createCacheHandler({ type: "redis" })`. |
| `branch` | Installs this branch's package (built and packed once per run) and wraps the config in `withCache`. |

Both handler variants then build and run `NEXT_DEPLOY_INSTANCES` (default 2) `next start`
processes on the job's Redis, behind `proxy.mjs`, a round-robin proxy. So only state shared
through Redis carries across requests. The baseline keeps a single instance. Two instances with
no shared cache would fail cache tests for reasons unrelated to any handler.

**`branch` skips itself until `withCache` exists.** If `packages/cache-handler/src/index.ts`
does not mention `withCache`, the `prepare-branch` job records a reason. The `branch` shards then
write a "skipped" result without running anything. That way the first runs still produce the
`baseline` and `pkg-16.5.1` numbers while the source is being rewritten.

## The gate

The job fails only when `branch` ran and either:

- **A regression:** a suite passes on `baseline` and does not pass on `branch`, and it is not
  listed in `known-failures.txt`.
- **Incomplete results:** a `baseline` or `branch` shard did not finish, or a suite path in
  `suites.txt` matched no files.

`pkg-16.5.1` is informational. A skipped `branch` never fails the job.

## Results

The `report` job aggregates every shard with `report.mjs` and uploads the `next-deploy-results`
artifact. It holds:

- **`<ref>.json`** (for example `v16.4.2.json`): per-suite status and test counts (passed,
  failed, skipped, total) for each variant, per-variant totals, and the run URL and commit.
  `results/baseline-v16.4.2.json` in this directory is a committed copy of it from a known run.
- **`<ref>.md`:** the same data as a table. It is also written to the job summary.

Test counts come from the jest JSON that `run-tests.js` writes next to each test file when
`NEXT_TEST_JOB` is set. They are from the last retry.

## Running it in CI

The workflow is `.github/workflows/next-deploy-tests.yml`. It runs in two cases:

- **On a PR** that touches `tests/next-deploy/**`, the workflow file, or
  `packages/cache-handler/src/**`.
- **By hand:** Actions → *Next.js deploy tests* → *Run workflow*. It takes these inputs:
  - `nextjsRef`: a vercel/next.js tag. It must be a published release, because the test apps
    install `next@<that version>` from npm.
  - `suite_filter`: an extended regex over the lines in `suites.txt`.
  - `use_cache`: passed to `withCache` as `useCache` in the `branch` variant.
  - `instances`: `2` or `1`.

The jobs run in this order:

1. **`build-nextjs`** checks out vercel/next.js at the ref and runs `pnpm install && pnpm build
   && pnpm install`. It saves the tree to the Actions cache, keyed on the ref. Later runs at the
   same ref skip the build.
2. **`prepare-branch`** runs the `withCache` gate, then builds and packs this branch's package
   once.
3. **`suites`** is a matrix of variant × 4 shards, 12 jobs. Each one restores the next.js build
   from the cache and runs its share of the test files. Files are dealt round-robin, so the
   13-file `cache-components` suite spreads out.
4. **`report`** aggregates and gates.

Redis is a `services:` container in the `suites` job.

## Files

| File | Role |
|---|---|
| `suites.txt` | The suite manifest, one per line: a directory or a single `*.test.ts`, relative to the next.js checkout. |
| `known-failures.txt` | Suites allowed to regress on `branch`. Give each one a reason and an issue link. It starts empty. |
| `run-suites.sh` | Runs one shard of one variant through `run-tests.js`, and writes `<variant>-<shard>.tsv` and the logs. |
| `e2e-deploy.sh` | `NEXT_TEST_DEPLOY_SCRIPT_PATH`. It injects the variant's handlers, runs `pnpm install` and the build, starts the instances and the proxy, and prints only the URL on stdout. |
| `e2e-logs.sh` | `NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH`. It replays the build and server logs, which hold the `BUILD_ID:` lines the harness parses. |
| `e2e-cleanup.sh` | `NEXT_TEST_CLEANUP_SCRIPT_PATH`. It kills the servers and the proxy. |
| `inject-handlers.mjs` | Adds the package to the app's `package.json` and replaces `next.config.*` with a wrapper for `branch` or `pkg-16.5.1`. |
| `proxy.mjs` | The round-robin HTTP proxy. Each response carries an `x-next-deploy-instance` header. |
| `report.mjs` | Aggregates the shards into `<ref>.json` and `<ref>.md`, and applies the gate. |

### How `next.config` is wrapped

`inject-handlers.mjs` handles all three config shapes the fixtures use:

- **`.js` / `.mjs`:** renamed to `next.config.user.cjs` or `next.config.user.mjs`.
- **`.ts` / `.mts`:** transpiled to CommonJS with TypeScript.
- **No config file:** wrapped as `{}`.

A generated `next.config.mjs` imports the user config. It removes the fixture's `cacheHandler`
and `cacheHandlers`, applies the variant (`withCache`, or `createCacheConfig`), then puts the
fixture's handlers back according to `NEXT_DEPLOY_FIXTURE_HANDLERS`:

- **`keep`** (the default): the fixture's handler wins in any slot it sets. Several fixtures
  assert on their own instrumented handlers, for example `use-cache`, `use-cache-swr` and
  `non-ascii-cache-item-name`.
- **`replace`:** ours take `default`, `remote` and the page slot. The fixture keeps only extra
  kinds.

The report's Notes column shows every kept or replaced slot.

## Environment

These are the harness variables. `run-suites.sh` sets them. The names come from
`test/lib/next-modes/next-deploy.ts` and `run-tests.js` at `v16.4.2`:

| Variable | Value |
|---|---|
| `NEXT_TEST_MODE` | `deploy` |
| `NEXT_TEST_DEPLOY_SCRIPT_PATH` | `e2e-deploy.sh`. It runs with cwd set to the test app, `NEXT_TEST_DIR` set, and no arguments. The harness reads stdout, trimmed, as the URL. |
| `NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH` | `e2e-logs.sh`. It is required with a custom deploy script. It must print `BUILD_ID:`, `DEPLOYMENT_ID:` and `NEXT_SUPPORTS_IMMUTABLE_ASSETS:`. |
| `NEXT_TEST_CLEANUP_SCRIPT_PATH` | `e2e-cleanup.sh`. It gets `NEXT_TEST_DEPLOY_URL`. |
| `NEXT_EXTERNAL_TESTS_FILTERS` | `test/deploy-tests-manifest.json`. This is Next's own list of tests that cannot run in deploy mode. |
| `NEXT_TEST_JOB`, `IS_TURBOPACK_TEST`, `NEXT_E2E_TEST_TIMEOUT`, `NEXT_TELEMETRY_DISABLED` | Set as in the docs. |

These are ours. The workflow sets them:

| Variable | Meaning |
|---|---|
| `NEXT_DEPLOY_VARIANT` | `baseline`, `pkg-16.5.1` or `branch`. |
| `NEXT_DEPLOY_SKIP_REASON` | When set, `run-suites.sh` records the whole variant as skipped. |
| `CACHE_HANDLER_TARBALL` | The output of `pnpm pack` for this branch. `branch` only. |
| `NEXT_DEPLOY_REDIS_URL` | The job's Redis. Each deployment gets its own `CACHE_KEY_PREFIX`, because two run at once. |
| `NEXT_DEPLOY_INSTANCES` | The number of `next start` processes for the handler variants. Default 2. |
| `NEXT_DEPLOY_USE_CACHE` | `useCache` for `withCache`. Default `memory`. |
| `NEXT_DEPLOY_FIXTURE_HANDLERS` | `keep` (default) or `replace`. See above. |
| `NEXT_REPO_DIR`, `RESULTS_DIR`, `SUITE_FILTER`, `SUITE_TIMEOUT`, `RETRIES`, `CONCURRENCY` | Settings for `run-suites.sh`. |

## Running it locally

It needs about 10 GB of disk and an hour. CI is the intended place to run it. You need Linux
(`e2e-deploy.sh` uses `setsid`), Docker, Node 22 and corepack:

```sh
git clone --depth 1 --branch v16.4.2 https://github.com/vercel/next.js ../next.js
(cd ../next.js && corepack enable && pnpm install && pnpm build && pnpm install \
  && pnpm playwright install chromium)
docker run -d --name next-deploy-redis -p 6379:6379 redis:7-alpine

export NEXT_REPO_DIR="$PWD/../next.js" RESULTS_DIR=/tmp/next-deploy-results
export NEXT_DEPLOY_REDIS_URL=redis://127.0.0.1:6379 SUITE_FILTER='use-cache-swr'
tests/next-deploy/run-suites.sh baseline 1 1
tests/next-deploy/run-suites.sh pkg-16.5.1 1 1
# branch: pnpm --filter @mrjasonroy/cache-components-cache-handler build, then pack it and
# export CACHE_HANDLER_TARBALL=<the .tgz>
NEXT_DEPLOY_SKIP_REASON="not built locally" tests/next-deploy/run-suites.sh branch 1 1
NEXT_REF=v16.4.2 node tests/next-deploy/report.mjs "$RESULTS_DIR" \
  tests/next-deploy/known-failures.txt 1 /tmp/next-deploy-report
```

## Triage

- **A suite regresses on `branch`:** read its log in the `next-deploy-branch-<shard>` artifact,
  under `logs/branch-<suite>-shard<n>.log`. Compare it with `pkg-16.5.1`. If 16.5.1 fails the
  same way, the cause is likely the multi-instance setup rather than the rewrite. A manual run
  with `instances: 1` tells the two apart. Fix the handler, or add the suite to
  `known-failures.txt` with the reason.
- **A suite fails on `baseline` too:** that is Next or the harness. It is shown, but it never
  gates.
- **A known failure starts passing:** the report lists it. Remove it from the file.
