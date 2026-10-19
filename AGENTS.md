# AI Agent Instructions

## Project Context

**@mrjasonroy/cache-components-cache-handler** is a Next.js 16+ `"use cache"` (data cache) handler library built with:
- **Turborepo** - Monorepo management
- **TypeScript** - Strict mode, full type safety
- **Biome** - Linting and formatting
- **Vitest + Playwright** - Testing
- **Docker Compose** - Infrastructure
- **pnpm** - Package management

## Project Goals

1. **Modern & Clean**: Use latest best practices, minimal dependencies
2. **Next.js 16+ Focus**: Full support for "use cache" directive and cache components
3. **Developer Experience**: Easy to install, test, and contribute to
4. **Production Ready**: Docker support, proper error handling, comprehensive tests
5. **AI-First**: Automated testing, version checking, and release management

## Code Standards

### TypeScript
- **Strict mode** enabled - no `any` types
- Use type inference where possible
- Export types from public API
- JSDoc comments for public APIs
- Prefer interfaces over types for objects

### Formatting (Biome)
- **Do not manually format** - Run `pnpm format` to fix all formatting
- Import organization is automatic
- 100 character line width
- 2 space indentation
- Double quotes for strings
- Always use semicolons
- Trailing commas everywhere

### Code Style
- **Minimal & clean** - Prefer composition over inheritance
- **Self-documenting** - Clear variable and function names
- **No console.log** - Use proper logging (we'll add later)
- **Error handling** - Always handle errors explicitly
- **Async/await** - Prefer over promises

### Testing
- Write tests for all new features
- Unit tests in `*.test.ts` files next to source
- E2E tests in `tests/e2e/`
- Aim for 80%+ coverage

## Workflow

### Before Making Changes
1. Read `CHANGELOG.md` for recent changes
2. Check `implementation/ISSUES.md` for known issues
3. Review `implementation/DECISIONS.md` for context (e.g. why the ISR `cacheHandler` exports were removed and restored)

### While Making Changes
1. Make your changes
2. Run `pnpm lint` to check for issues
3. Run `pnpm format` to fix formatting
4. Run `pnpm typecheck` to verify types
5. Run `pnpm test` to ensure tests pass

### After Making Changes
1. Add a `CHANGELOG.md` entry for user-facing changes
2. Document important decisions in `implementation/DECISIONS.md`
3. Add any issues to `implementation/ISSUES.md`

## Key Commands

```bash
# Development
pnpm dev              # Start all apps in dev mode
pnpm build            # Build all packages
pnpm test             # Run all tests
pnpm test:e2e         # Run Playwright tests

# Code Quality
pnpm lint             # Check for linting issues
pnpm format           # Format all code with Biome
pnpm typecheck        # TypeScript type checking

# Docker
pnpm docker:up        # Start Redis and services
pnpm docker:down      # Stop all services

# Cleanup
pnpm clean            # Remove all build artifacts
```

## Next.js 16 Cache API

This project focuses on Next.js 16's new caching system:

- **"use cache" directive** - Component-level caching
- **Cache Components** - Full page caching
- **Tag-based revalidation** - Invalidate by tags
- **Time-based revalidation** - TTL support
- **Build-time caching** - Prime cache during build

**Key Resources:**
- [Cache Components](https://nextjs.org/docs/app/getting-started/cache-components)
- [Caching and Revalidating](https://nextjs.org/docs/app/getting-started/caching-and-revalidating)
- [cacheHandlers API](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers) (the main API; the ISR `cacheHandler` handlers live in `src/handlers/`)

## Package Structure

```
packages/
└── cache-handler/              # @mrjasonroy/cache-components-cache-handler
    ├── src/
    │   ├── data-cache/
    │   │   ├── types.ts           # DataCacheHandler / DataCacheEntry types
    │   │   ├── memory.ts          # Memory handler
    │   │   ├── redis.ts           # Redis/Valkey/ElastiCache handler
    │   │   ├── ioredis-adapter.ts # ioredis -> node-redis-style client adapter
    │   │   └── factory.ts         # createCacheHandler zero-config factory
    │   ├── handlers/              # ISR cacheHandler handlers (memory, redis, composite)
    │   ├── helpers/
    │   │   ├── load-ioredis.ts    # lazy ioredis loader
    │   │   └── next-config.ts     # createCacheConfig helpers
    │   └── index.ts               # Public API
    └── package.json

apps/
├── e2e-test-app/               # Playwright e2e suite (memory, redis, valkey, elasticache)
└── redis-example/              # Minimal Redis example
```

## When Making Changes

### Adding a New Feature
1. Add types to `src/data-cache/types.ts` if needed
2. Implement in appropriate handler file
3. Export from `src/index.ts`
4. Write tests in `*.test.ts` file
5. Update package README if it's user-facing

### Fixing a Bug
1. Write a failing test first
2. Fix the bug
3. Verify test passes
4. Document in `implementation/ISSUES.md`

### Updating Documentation
1. Update relevant README files
2. Update JSDoc comments
3. Update examples if needed

## Git Workflow

### Pre-Commit Checklist (CRITICAL)
**ALWAYS run these commands before EVERY commit:**
```bash
pnpm lint          # Check for linting issues
pnpm format        # Fix all formatting (including JSON files)
pnpm typecheck     # Verify TypeScript types
```

This is non-negotiable. CI will fail if formatting is incorrect, even for JSON files like package.json. Biome formats everything, not just TypeScript.

### Commits
Use conventional commits:
- `feat: add Redis cluster support`
- `fix: handle connection timeout correctly`
- `docs: update installation guide`
- `test: add e2e tests for revalidation`
- `chore: update dependencies`

### Branches
- `main` - Production-ready code
- Feature branches for development
- Merge via PR only

## Common Patterns

### Creating a Cache Handler

Data cache handlers implement Next's `cacheHandlers` (plural) `DataCacheHandler` contract. The ISR
handlers in `src/handlers/` implement the singular `cacheHandler` one (see `implementation/DECISIONS.md`):

```typescript
import type { DataCacheEntry, DataCacheHandler, Timestamp } from "./types.js";

export function createMyDataCacheHandler(): DataCacheHandler {
  return {
    async get(cacheKey: string, softTags: string[]): Promise<DataCacheEntry | undefined> {
      // Implementation
    },
    async set(cacheKey: string, pendingEntry: Promise<DataCacheEntry>): Promise<void> {
      // Implementation
    },
    async refreshTags(): Promise<void> {},
    async getExpiration(tags: string[]): Promise<Timestamp> {
      // Implementation
    },
    async updateTags(tags: string[], durations?: { expire?: number }): Promise<void> {
      // Implementation
    },
  };
}
```

### Error Handling

```typescript
try {
  await operation();
} catch (error) {
  // Log error properly
  throw new Error(`Failed to perform operation: ${error instanceof Error ? error.message : "Unknown error"}`);
}
```

### Testing

```typescript
import { describe, test, expect } from "vitest";

describe("createMemoryDataCacheHandler", () => {
  test("returns undefined for a missing key", async () => {
    const handler = createMemoryDataCacheHandler();

    expect(await handler.get("missing", [])).toBeUndefined();
  });
});
```

## AI-Specific Instructions

### When Analyzing Code
- Check `implementation/` folder first for context
- Read existing code before suggesting changes
- Follow established patterns

### When Creating PRs
- Reference related issues
- Include test changes
- Update documentation
- Run all checks before submitting

### When Finding Issues
- Document in `implementation/ISSUES.md`
- Include reproduction steps
- Suggest potential solutions

## Questions?

If you're unsure about anything:
1. Check existing code for patterns
2. Review `implementation/DECISIONS.md`
3. Look at test files for examples
4. Ask the maintainer

---

**Remember**: Clean, minimal, well-tested code is the goal. Quality over quantity! 🎯
