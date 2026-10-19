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
pnpm lint             # Check for linting issues
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

# Valkey, with plain "use cache" stored in Redis too
REDIS_URL=redis://localhost:6380 E2E_REDIS_CONTAINER=nextjs-cache-valkey E2E_USE_CACHE=redis \
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

### Next.js's own caching suites

`tests/next-deploy/` runs Next.js's caching e2e suites in deploy mode against the package. It runs
in CI; see [tests/next-deploy/README.md](../tests/next-deploy/README.md).

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

### First-Time Setup: GitHub Environment

Before you can publish, configure the "publish" environment in GitHub with manual approval:

1. Go to **Settings** → **Environments** in your GitHub repository
2. Click **New environment** and name it `publish`
3. Under **Deployment protection rules**, enable **Required reviewers**
4. Add yourself (or trusted maintainers) as a required reviewer
5. Click **Save protection rules**

This ensures all npm publishes require manual approval for security.

### Publishing a Release

1. Update version in `packages/cache-handler/package.json`
2. Commit: `git commit -m "chore: bump version to 16.0.1"`
3. Create git tag: `git tag v16.0.1`
4. Push commits and tag: `git push origin main --tags`
5. GitHub Actions will:
   - Run all tests (lint, typecheck, unit, e2e)
   - Wait for your approval (check **Actions** tab)
   - Publish to npm after approval

### Publishing Pre-releases

For alpha/beta/rc versions:

```bash
# Alpha
git tag v16.0.1-alpha.0
git push origin v16.0.1-alpha.0

# Beta
git tag v16.0.1-beta.0
git push origin v16.0.1-beta.0

# Release Candidate
git tag v16.0.1-rc.0
git push origin v16.0.1-rc.0
```

Pre-releases are published with corresponding npm dist-tags (`@alpha`, `@beta`, `@rc`).

## CI/CD

- **CI**: Runs on all PRs (lint, typecheck, unit tests, the Redis outage suite, and e2e on memory, Redis, Valkey, ElastiCache mode and custom handlers)
- **Next.js deploy tests**: Next.js's own caching suites against the package, on PRs that touch the package source
- **Publish**: Runs on version tags (tests + npm publish)
- **Version Check**: Runs daily to check for new Next.js versions
