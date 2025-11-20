# @mrjasonroy/cache-components-cache-handler

Cache handler for Next.js 16+ with support for Cache Components and "use cache" directive.

> Why another cache handler? I was originally going to contribute to [fortedigital/nextjs-cache-handler](https://github.com/fortedigital/nextjs-cache-handler) but that project is focused on backwards compatibility and carries a lot of legacy baggage. This repo is a ground-up rewrite that:
> - Targets **Next.js 16+ only** (Cache Components, `"use cache"`, `cacheLife`, etc.)
> - Ships with **true E2E coverage** (Playwright + Next 16) for every backend
> - Keeps the surface area small: zero-config memory handler for dev, Redis/Valkey/ElastiCache factory for prod
> - Provides an AI-first workflow so contributors (human or agent) can ship confidently

[![npm version](https://badge.fury.io/js/@mrjasonroy%2Fcache-components-cache-handler.svg)](https://www.npmjs.com/package/@mrjasonroy/cache-components-cache-handler)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![Next.js 16+](https://img.shields.io/badge/Next.js-16%2B-black)](https://nextjs.org/)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](https://github.com/mrjasonroy/cache-components-cache-handler/tree/main/apps/e2e-test-app)

**📦 [View on npm](https://www.npmjs.com/package/@mrjasonroy/cache-components-cache-handler) | 🚀 [Releases](https://github.com/mrjasonroy/cache-components-cache-handler/releases)**

## What This Does

Implements Next.js 16+ caching APIs:
- `"use cache"` directive
- `cacheLife()` - Configure cache lifetime
- `cacheTag()` - Tag cache entries
- `revalidateTag()` - Invalidate by tags
- `updateTag()` - Update tags
- `revalidatePath()` - Invalidate by path
- Cache Components and PPR

## Supported Backends

All backends are **integration tested** with Next.js 16+ in CI so you can trust a release tag.

| Backend | Use Case | Key Features |
|---------|----------|--------------|
| **Memory** | Development, Single-instance | Zero config, fast, no external dependencies |
| **Redis** | Production, Distributed | Industry standard, high performance, clustering |
| **Valkey** | Production, Open Source | Redis-compatible, LGPL licensed, drop-in replacement |
| **AWS ElastiCache** | Production, Managed | Fully managed, IAM auth, auto-scaling, high availability |

## Install

```bash
npm install @mrjasonroy/cache-components-cache-handler

# For Redis/Valkey/ElastiCache, also install ioredis
npm install ioredis
```

## Quick Start

### Zero-Config (Recommended)

```javascript
// data-cache-handler.mjs
import { createCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

// Memory (dev)
export default createCacheHandler({ type: "memory" });

// Redis (production)
export default createCacheHandler({ type: "redis" });

// Valkey (production)
export default createCacheHandler({ type: "valkey" });

// ElastiCache (AWS)
export default createCacheHandler({ type: "elasticache" });
```

```javascript
// next.config.js
export default {
  cacheComponents: true,
  cacheHandlers: {
    default: "./data-cache-handler.mjs",
    remote: "./data-cache-handler.mjs",
  },
  cacheMaxMemorySize: 0, // Disable Next's built-in in-memory handler
};
```

**Environment Variables:**
- `REDIS_URL` / `VALKEY_URL` - Primary connection string for Redis-compatible stores (Valkey works with the same URI format, e.g. `redis://localhost:6380` when using the provided docker-compose service)
- `REDIS_PASSWORD` - Password/token used when your URL lacks credentials (works for every backend)
- `ELASTICACHE_ENDPOINT` / `ELASTICACHE_PORT` - AWS ElastiCache hostname + port
- `ELASTICACHE_TLS` - `"true"`/`"false"` toggle (defaults to `true` for ElastiCache)
- `ELASTICACHE_AUTH_TOKEN` - Password/token for IAM-authenticated ElastiCache clusters

### Advanced: Custom Configuration

Need more control? You can override any option:

```javascript
// data-cache-handler.mjs
import { createCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

export default createCacheHandler({
  type: "elasticache",
  endpoint: "cache.prod-cluster.cache.amazonaws.com",
  port: 6380,
  tls: true,
  password: process.env.CACHE_AUTH_TOKEN,
  keyPrefix: "myapp:cache:",
  tagPrefix: "myapp:tags:",
  debug: process.env.NODE_ENV === "development",
});
```

## Usage

```typescript
// Basic caching
async function ProductList() {
  "use cache";
  const products = await db.products.findMany();
  return <ProductGrid products={products} />;
}

// With cache lifetime
import { cacheLife } from "next/cache";

async function BlogPost({ id }: { id: string }) {
  "use cache";
  cacheLife("hours"); // 1 hour
  const post = await db.posts.findUnique({ where: { id } });
  return <Article post={post} />;
}

// With tags for selective invalidation
import { cacheTag } from "next/cache";

async function UserProfile({ userId }: { userId: string }) {
  "use cache";
  cacheTag("user-profile", `user:${userId}`);
  const user = await db.user.findUnique({ where: { id: userId } });
  return <Profile user={user} />;
}

// Invalidate from API route
import { revalidateTag } from "next/cache";

export async function POST(request: Request) {
  const { userId } = await request.json();
  revalidateTag(`user:${userId}`);
  return Response.json({ revalidated: true });
}
```

## Cache Handler API

This library implements the Next.js 16+ `DataCacheHandler` interface:

```typescript
interface DataCacheHandler {
  // Retrieve cached entry for a cache key
  get(cacheKey: string, softTags: string[]): Promise<DataCacheEntry | undefined>;

  // Store a cache entry (handles streaming responses)
  set(cacheKey: string, pendingEntry: Promise<DataCacheEntry>): Promise<void>;

  // Called periodically to refresh local tag manifest
  refreshTags(): Promise<void>;

  // Get maximum revalidation timestamp for tags
  getExpiration(tags: string[]): Promise<Timestamp>;

  // Called when revalidateTag() invalidates tags
  updateTags(tags: string[], durations?: { expire?: number }): Promise<void>;
}
```

When you call `revalidateTag('my-tag')` in your application, Next.js internally calls our `updateTags(['my-tag'])` implementation, which marks all cache entries with that tag as stale.

## Documentation

- [GitHub Repository](https://github.com/mrjasonroy/cache-components-cache-handler)
- [Redis Configuration](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/redis.md)
- [Valkey & ElastiCache Setup](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/redis.md#valkey)
- [Contributing](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/CONTRIBUTING.md)

## CI & Test Matrix

| Workflow | What it Verifies |
|----------|------------------|
| **CI** | Biome lint + format check, typecheck, Vitest, and Playwright e2e suites against Memory, Redis, Valkey, and ElastiCache-mode backends |
| **Next.js Canary Test** | Daily compatibility runs against Next.js canary/rc/latest to catch upstream breakage |
| **Next.js Version Check** | Nightly scan for new Next.js releases, opens PRs to bump peer deps |
| **Publish** | Trusted publishing with provenance – release tags must pass the full matrix before npm sees them |

## Development

```bash
git clone https://github.com/mrjasonroy/cache-components-cache-handler
cd cache-components-cache-handler
pnpm install
pnpm build
pnpm test
```

## Contributing

This project is AI-friendly and contributor-friendly.

- **For AI Agents:** See [CLAUDE.md](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/CLAUDE.md) for instructions
- **For Humans:** See [CONTRIBUTING.md](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/CONTRIBUTING.md)

## License

MIT © [Jason Roy](https://github.com/mrjasonroy)

## Acknowledgments

Forked from/Inspired by [@fortedigital/nextjs-cache-handler](https://github.com/fortedigital/nextjs-cache-handler), but focusing only on supporting Next.js 16+ and the new caching system.
