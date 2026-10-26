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
| `pkg-16.4.2` | Installs the **published** `@mrjasonroy/cache-components-cache-handler@16.4.2` from npm and wires it the 16.4.2 way: `cacheHandlers.default` / `remote` pointing at a generated `data-cache-handler.mjs` that exports `createCacheHandler({ type: "redis" })`, and `cacheMaxMemorySize: 0`. |
| `branch` | Installs this branch's package (built and packed once per run) and wraps the config in `withCache`. |

Both handler variants then build and run `NEXT_DEPLOY_INSTANCES` (default 2) `next start`
processes on the job's Redis, behind `proxy.mjs`, a round-robin proxy. So only state shared
through Redis carries across requests. The baseline keeps a single instance. Two instances with
no shared cache would fail cache tests for reasons unrelated to any handler.

**A fixture with its own handler runs one instance.** When `inject-handlers.mjs` keeps a
fixture's own `cacheHandler` or `cacheHandlers.*` (see below), that handler keeps its entries in
process memory. Behind round-robin it cannot be consistent, and Next makes no cross-instance
promise for it. So `e2e-deploy.sh` starts a single instance for that suite, in both handler
variants, and the Notes column says `1 instance (fixture handler is per-process)`. Example:
`use-cache-infinity-profile`.

**`branch` skips itself until `withCache` exists.** If `packages/cache-handler/src/index.ts`
does not mention `withCache`, the `prepare-branch` job records a reason. The `branch` shards then
write a "skipped" result without running anything. That way the first runs still produce the
`baseline` and `pkg-16.4.2` numbers while the source is being rewritten.

## The gate

The job fails only when `branch` ran and either:

- **A regression:** a suite passes on `baseline` and does not pass on `branch`, or `branch`
  passes fewer of its tests than `baseline` does, or a test that passes on `baseline` does not
  pass on `branch` (this catches a suite that already fails on `baseline`, even when one test
  newly fails while another is fixed), and it is not listed in `known-failures.txt`. Tests are
  compared by file and exact full name, from the jest results (`<variant>-<shard>.tests.jsonl`);
  results without that file are compared by counts only. A full name jest reports more than once
  in a file is compared by how many of it pass, since which of them passed cannot be told apart.
  A suite in `known-failures.txt` is not checked at all. `node --test tests/next-deploy/report.test.mjs` (run in CI) checks
  the gate end to end on small fixtures.
- **Incomplete results:** a `baseline` or `branch` shard did not finish, or a suite has no result
  on one of them (a suite path in `suites.txt` that matched no files).

`pkg-16.4.2` is informational. A skipped `branch` never fails the job.

### Known failures

`known-failures.txt` lists suites allowed to fail on `branch`, one per line:

```
<suite>  [<constraint>]  <reason with an issue link>
```

The optional constraint limits the entry to some Next.js refs, compared with `nextjsRef`:
`<16.5.0-canary.10` applies only below that version, and `<`, `<=`, `>`, `>=` all work
(prereleases sort before their release). Use it for a bug in Next itself, with the first fixed
version, so the entry stops applying once the workflow tests a fixed release. Such an entry's
verdict reads **known Next bug**; one without a constraint reads **known failure**. A ref that is
not a version matches every constraint.

The current entry is `test/e2e/app-dir/app-static` below `16.5.0-canary.10`: Turbopack's
`edgeCacheHandlersRegistration` injection emits object-literal fragments at statement position,
so any non-empty `cacheHandlers` plus an edge route handler fails the build. It is fixed by
vercel/next.js#100046, first released in `v16.5.0-canary.10`, and is not in `16.4.2`. Every
handler variant hits it, so app-static fails on both.

## Results

The `report` job aggregates every shard with `report.mjs` and uploads the `next-deploy-results`
artifact. It holds:

- **`<ref>.json`** (for example `v16.4.2.json`): per-suite status and test counts (passed,
  failed, skipped, total) for each variant, per-variant totals, and the run URL and commit.
  `results/baseline-v16.4.2.json` in this directory is a committed copy of it from a known run.
  Its informational `pkg-published` column came from an earlier published build of the package,
  not from the current `pkg-16.4.2` variant.
- **`<ref>.md`:** the same data as a table. It is also written to the job summary.

Test counts come from the run-tests.js log (`count-results.mjs`). With
`NEXT_TEST_EMIT_ALL_OUTPUT=1`, `run-tests.js` prints each test file's jest JSON after its last
attempt as one line, `--test output start-- {json} --test output end--`. The counts are from that
last attempt. The `<file>.results.json` files that `run-tests.js` also writes are only a
fallback. Before each retry `run-tests.js` runs `git clean -fdx` on the suite directory, which
deletes the results of every other file in it, so counting those files undercounted any suite
with a retry: `cache-components` showed 33 tests instead of 79 in run 39336221878. A suite part
that still has files without results gets a warning in the job log.

When a suite part does not pass, the shard artifact also holds
`server-logs/<variant>-shard<n>/<suite>/<test app>/`: the last 200 lines of every `next start`
log and the proxy log, saved by `e2e-cleanup.sh` before it stops the servers. The same tails go
to the cleanup script's stderr, so a runtime 500 can also show up next to the failing test.

## Running it in CI

The workflow is `.github/workflows/next-deploy-tests.yml`. It runs in two cases:

- **On a PR** that touches `tests/next-deploy/**`, the workflow file, or
  `packages/cache-handler/src/**` or `packages/cache-handler/package.json`.
- **By hand:** Actions → *Next.js deploy tests* → *Run workflow*. It takes these inputs:
  - `nextjsRef`: a vercel/next.js tag. It must be a published release, because the test apps
    install `next@<that version>` from npm. Empty (the default, and every PR run) means the
    package's `next` dev dependency, the version its unit tests run against. The Next update
    workflows bump that, so the harness follows each Next release.
  - `suite_filter`: an extended regex over the lines in `suites.txt`.
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
| `known-failures.txt` | Suites allowed to regress on `branch`, optionally only for some Next.js versions. See [Known failures](#known-failures). |
| `run-suites.sh` | Runs one shard of one variant through `run-tests.js`, and writes `<variant>-<shard>.tsv` and the logs. |
| `count-results.mjs` | Sums a suite part's test counts from the jest JSON in its run-tests.js log. |
| `e2e-deploy.sh` | `NEXT_TEST_DEPLOY_SCRIPT_PATH`. It injects the variant's handlers, runs `pnpm install` and the build, starts the instances and the proxy, and prints only the URL on stdout. |
| `e2e-logs.sh` | `NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH`. It replays the build and server logs, which hold the `BUILD_ID:` lines the harness parses. |
| `e2e-cleanup.sh` | `NEXT_TEST_CLEANUP_SCRIPT_PATH`. It saves the tails of the server and proxy logs, then kills the servers and the proxy. |
| `inject-handlers.mjs` | Adds the packages to the app's `package.json` and replaces `next.config.*` with a wrapper for `branch` or `pkg-16.4.2`. |
| `proxy.mjs` | The round-robin HTTP proxy. Each response carries an `x-next-deploy-instance` header. |
| `report.mjs` | Aggregates the shards into `<ref>.json` and `<ref>.md`, and applies the gate. |

### How `next.config` is wrapped

`inject-handlers.mjs` handles all three config shapes the fixtures use:

- **`.js` / `.mjs`:** renamed to `next.config.user.cjs` or `next.config.user.mjs`.
- **`.ts` / `.mts`:** transpiled to CommonJS with TypeScript.
- **No config file:** wrapped as `{}`.

A generated `next.config.mjs` imports the user config. It removes the fixture's `cacheHandler`
and `cacheHandlers`, applies the variant (`withCache`, or `createCacheConfig`), then puts the
fixture's handlers back according to `NEXT_DEPLOY_FIXTURE_HANDLERS`. If any fixture handler
survives, it also writes `.handler-instances`, which makes `e2e-deploy.sh` start one instance:

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
| `NEXT_TEST_EMIT_ALL_OUTPUT` | `1`, so every test file's jest JSON lands in the log (see [Results](#results)). |

These are ours. The workflow sets them:

| Variable | Meaning |
|---|---|
| `NEXT_DEPLOY_VARIANT` | `baseline`, `pkg-16.4.2` or `branch`. |
| `NEXT_DEPLOY_SKIP_REASON` | When set, `run-suites.sh` records the whole variant as skipped. |
| `CACHE_HANDLER_TARBALL` | The output of `pnpm pack` for this branch. `branch` only. |
| `NEXT_DEPLOY_REDIS_URL` | The job's Redis. Each deployment gets its own `CACHE_KEY_PREFIX`, because two run at once. |
| `NEXT_DEPLOY_INSTANCES` | The number of `next start` processes for the handler variants. Default 2. |
| `NEXT_DEPLOY_FIXTURE_HANDLERS` | `keep` (default) or `replace`. See above. |
| `NEXT_DEPLOY_SERVER_LOGS_DIR` | Set per suite part by `run-suites.sh`; where `e2e-cleanup.sh` saves log tails. |
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
tests/next-deploy/run-suites.sh pkg-16.4.2 1 1
# branch: pnpm --filter @mrjasonroy/cache-components-cache-handler build, then pack it and
# export CACHE_HANDLER_TARBALL=<the .tgz>
NEXT_DEPLOY_SKIP_REASON="not built locally" tests/next-deploy/run-suites.sh branch 1 1
NEXT_REF=v16.4.2 node tests/next-deploy/report.mjs "$RESULTS_DIR" \
  tests/next-deploy/known-failures.txt 1 /tmp/next-deploy-report
```

## Triage

- **A suite regresses on `branch`:** read its log in the `next-deploy-branch-<shard>` artifact,
  under `logs/branch-<suite>-shard<n>.log`. Compare it with `pkg-16.4.2`. If 16.4.2 fails the
  same way, the cause is likely the multi-instance setup rather than the rewrite. A manual run
  with `instances: 1` tells the two apart. Fix the handler, or add the suite to
  `known-failures.txt` with the reason.
- **A handler variant returns 500s:** open `server-logs/` in that shard's artifact (see
  [Results](#results)) for the server's own error.
- **A suite fails on `baseline` too:** that is Next or the harness. It is shown, but it never
  gates.
- **A known failure starts passing:** the report lists it. Remove it from the file.
