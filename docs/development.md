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
│   ├── cache-handler/          # Core package
│   └── cache-handler-redis/    # Redis adapter
├── apps/
│   ├── e2e-test-app/          # E2E test application
│   └── legacy-cache-test/     # Legacy test application
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

### E2E Tests

```bash
# Start containers (Redis + Valkey)
pnpm docker:up

# Memory backend
pnpm --filter e2e-test-app build
pnpm --filter e2e-test-app test:e2e

# Redis backend (flush cache between runs)
docker exec nextjs-cache-redis redis-cli FLUSHALL
CACHE_HANDLER=redis REDIS_URL=redis://localhost:6379 pnpm --filter e2e-test-app test:e2e

# ElastiCache backend (reuses Redis container)
docker exec nextjs-cache-redis redis-cli FLUSHALL
CACHE_HANDLER=elasticache ELASTICACHE_ENDPOINT=localhost ELASTICACHE_PORT=6379 ELASTICACHE_TLS=false pnpm --filter e2e-test-app test:e2e

# Valkey backend (optional local check; CI runs this automatically)
docker exec nextjs-cache-valkey valkey-cli -p 6379 FLUSHALL
CACHE_HANDLER=redis REDIS_URL=redis://localhost:6380 pnpm --filter e2e-test-app test:e2e

# Stop containers
pnpm docker:down
```

### Unit Tests

```bash
pnpm --filter @mrjasonroy/cache-components-cache-handler test
```

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

- **CI**: Runs on all PRs (lint, typecheck, test with memory & Redis)
- **Publish**: Runs on version tags (tests + npm publish)
- **Version Check**: Runs daily to check for new Next.js versions
