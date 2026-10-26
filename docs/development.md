# Development

## Setup

```bash
git clone https://github.com/mrjasonroy/cache-components-cache-handler
cd cache-components-cache-handler
pnpm install
pnpm build
```

## Project Structure

```
cache-components-cache-handler/
├── packages/
│   └── cache-handler/          # The published package (withCache and its handlers)
├── apps/
│   ├── e2e-test-app/          # E2E test application (Playwright)
│   └── redis-example/         # Minimal Redis example app
├── docs/                       # Documentation
└── .github/workflows/         # CI/CD
```

## Commands

```bash
# Development
pnpm dev              # Start all apps in dev mode
pnpm build            # Build all packages
pnpm test             # Run all tests
pnpm test:e2e         # Run Playwright e2e tests

# Code Quality
pnpm lint             # Check for linting issues, and that the npm README matches README.md
pnpm readme:sync      # Regenerate packages/cache-handler/README.md from README.md
pnpm format           # Format all code
pnpm typecheck        # TypeScript type checking

# Docker
pnpm docker:up        # Start Redis
pnpm docker:down      # Stop Redis

# Cleanup
pnpm clean            # Remove all build artifacts
```

## Running Tests

### Unit Tests

```bash
pnpm --filter @mrjasonroy/cache-components-cache-handler test
```

### Redis outage suite

Runs against a disposable Redis container that the tests stop, start, pause and unpause:

```bash
docker run -d --name cache-test-redis -p 6390:6379 redis:7-alpine
CACHE_TEST_REDIS_URL=redis://localhost:6390 CACHE_TEST_REDIS_CONTAINER=cache-test-redis \
  pnpm --filter @mrjasonroy/cache-components-cache-handler test:redis
```

### E2E Tests

The e2e app is wired with `withCache` and picks its backend from the environment, like a real app.
Always test a production build: `"use cache"` does not persist in dev mode.

```bash
# Memory: no REDIS_URL
pnpm --filter e2e-test-app build
pnpm --filter e2e-test-app test:e2e

# Redis: starts a second instance on port 3001 for the cross-instance specs
pnpm docker:up
docker exec nextjs-cache-redis redis-cli FLUSHALL
pnpm --filter e2e-test-app build
pnpm --filter e2e-test-app test:e2e:redis

# Valkey
REDIS_URL=redis://localhost:6380 E2E_REDIS_CONTAINER=nextjs-cache-valkey \
  sh -c 'pnpm --filter e2e-test-app build && pnpm --filter e2e-test-app test:e2e'

# Custom handler files (apps/e2e-test-app/cache/*.mjs) instead of the built-in ones
E2E_CUSTOM_HANDLERS=1 pnpm --filter e2e-test-app build
E2E_CUSTOM_HANDLERS=1 pnpm --filter e2e-test-app test:e2e:redis

# The outage spec stops Redis under both instances, so it runs on its own
E2E_OUTAGE=1 pnpm --filter e2e-test-app test:e2e:redis

pnpm docker:down
```

`.github/workflows/ci.yml` is the reference for each lane's exact environment, including the
ElastiCache lane (TLS and an auth token).

### ElastiCache IAM against a real cache

`packages/cache-handler/src/integration/elasticache-iam.e2e.test.ts` runs against a real
IAM-enabled ElastiCache cache and is skipped unless `ELASTICACHE_IAM_E2E=1`. It needs a network
path into the cache's VPC and AWS credentials allowed `elasticache:Connect`, so it is not in
per-PR CI; run it before a release that touches the connection or IAM code.

`scripts/aws-iam-e2e/run.sh <ref>` (a branch such as `origin/feat/x`, a SHA, or `pr/84`)
starts the runner instance (EC2, tagged `Name=cch-iam-e2e-runner`, in the cache's VPC), waits for
SSM, checks out the ref, builds, runs the test against the serverless cache `cch-iam-e2e`, prints
the output and stops the instance again. Its exit code is the test's. It needs the AWS CLI, `jq`
and an AWS profile for the account that holds the cache: set `AWS_PROFILE` and `AWS_REGION`
(else the profile's region). The instance and the cache endpoint are looked up by name at run
time; `CCH_INSTANCE_NAME`, `CCH_CACHE_NAME` and `CCH_IAM_USER` override the names.
`scripts/aws-iam-e2e/teardown.sh` deletes the runner, its role, the cache, the user group, the
user and the security groups, and is safe to run twice.

To run it from a machine that can reach a cache directly:

```bash
ELASTICACHE_IAM_E2E=1 ELASTICACHE_ENDPOINT=<endpoint> ELASTICACHE_IAM_USER=<user id> \
ELASTICACHE_CACHE_NAME=<cache name> ELASTICACHE_REGION=<region> \
  pnpm --filter @mrjasonroy/cache-components-cache-handler exec vitest run src/integration/elasticache-iam
```

### Next.js's own caching suites

`tests/next-deploy/` runs Next.js's caching e2e suites in deploy mode against the package. It runs
in CI; see [tests/next-deploy/README.md](../tests/next-deploy/README.md).

## How it's tested

- **Unit tests** for every module: the codec, the connection, the fallback, the tag store, the page
  handler's Next 16 contract, `withCache` and `flushCache`.
- **A real-Redis outage suite** in CI on Redis 7 and Valkey 8: Redis down at boot, lost mid-run,
  stalled (`docker pause`) and back; a tag revalidation reaching the page, remote and local
  handlers; the build phase never connecting; build-ID scoping and tags crossing builds.
- **End-to-end tests on production builds** (`next build && next start`) with Playwright, against
  memory, Redis, Valkey and TLS + AUTH ElastiCache mode. They cover pages, `"use cache"`,
  `"use cache: remote"`, `revalidateTag`, `revalidatePath`, two instances sharing Redis, and Redis
  stopped mid-run.
- **Next.js's own caching suites** through its deploy-test harness: each suite runs against a
  plain `next start` baseline and against the package with two instances behind a proxy, and a
  suite that passes on the baseline must pass with the package. See
  [tests/next-deploy/README.md](../tests/next-deploy/README.md).
- **ElastiCache IAM against a real ElastiCache Serverless cache** (Valkey 8.1), by hand before a
  release: token auth, re-authentication, reconnect, a revalidation across two connections and
  `flushCache` ([above](#elasticache-iam-against-a-real-cache)). Signing and refresh are
  unit-tested in CI.

| Workflow | What it verifies |
|---|---|
| `.github/workflows/ci.yml` | Lint, format, typecheck, unit tests, the Redis outage suite and the e2e matrix |
| `.github/workflows/next-deploy-tests.yml` | Next.js's caching suites in deploy mode |
| `.github/workflows/nextjs-canary-test.yml` | Daily compatibility runs against Next.js canary and latest |
| `.github/workflows/nextjs-version-check.yml` | Nightly scan for new Next.js releases; opens bump PRs |
| `.github/workflows/publish.yml` | Trusted publishing with provenance |

## Code Standards

- TypeScript strict mode
- Biome for linting and formatting
- Run `pnpm format` before committing
- Run `pnpm lint` to check
- Run `pnpm typecheck` to verify types

## Making Changes

1. Create a feature branch
2. Make your changes
3. Run `pnpm lint && pnpm typecheck && pnpm test`
4. Commit with conventional commits format
5. Submit a pull request

## Conventional Commits

```bash
feat: add new feature
fix: fix a bug
docs: update documentation
test: add tests
chore: update dependencies
```

## Release Process

Releases are automated: merging a pull request from a `version-bump/`, `nextjs-` or `catch-up-`
branch to `main` tags the version in `packages/cache-handler/package.json` and publishes it to
npm. See [auto-release.md](./auto-release.md) and
[publishing/RELEASE.md](./publishing/RELEASE.md) (pre-releases:
[publishing/PRERELEASE.md](./publishing/PRERELEASE.md); the automated workflow:
[publishing/AUTOMATED_RELEASE.md](./publishing/AUTOMATED_RELEASE.md)).

## CI/CD

- **CI**: Runs on all PRs (lint, typecheck, unit tests, the Redis outage suite, and e2e on memory, Redis, Valkey, ElastiCache mode and custom handlers)
- **Next.js deploy tests**: Next.js's own caching suites against the package, on PRs that touch the package source
- **Publish**: Runs on version tags (tests + npm publish)
- **Version Check**: Runs daily to check for new Next.js versions
