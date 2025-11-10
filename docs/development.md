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
# With memory cache
pnpm --filter e2e-test-app build
pnpm --filter e2e-test-app start &
pnpm --filter e2e-test-app test:e2e

# With Redis
pnpm docker:up
pnpm --filter e2e-test-app build:redis
pnpm --filter e2e-test-app start:redis &
pnpm --filter e2e-test-app test:e2e
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

1. Update version in package.json files
2. Update CHANGELOG.md
3. Create git tag: `git tag v16.0.1`
4. Push tag: `git push origin v16.0.1`
5. GitHub Actions will run tests and publish to npm

## CI/CD

- **CI**: Runs on all PRs (lint, typecheck, test with memory & Redis)
- **Publish**: Runs on version tags (tests + npm publish)
- **Version Check**: Runs daily to check for new Next.js versions
