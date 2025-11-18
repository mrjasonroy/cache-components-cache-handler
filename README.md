# Cache Components Cache Handler

Cache handler for Next.js 16+ with support for Cache Components and "use cache" directive.

[![npm version](https://badge.fury.io/js/@mrjasonroy%2Fcache-components-cache-handler.svg)](https://www.npmjs.com/package/@mrjasonroy/cache-components-cache-handler)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![Next.js 16+](https://img.shields.io/badge/Next.js-16%2B-black)](https://nextjs.org/)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](./apps/e2e-test-app)

**📦 [View on npm](https://www.npmjs.com/package/@mrjasonroy/cache-components-cache-handler) | 🚀 [Releases](https://github.com/mrjasonroy/cache-components-cache-handler/releases)**

## What This Does

Implements Next.js 16+ caching APIs:
- `"use cache"` directive
- `cacheLife()` - Configure cache lifetime
- `cacheTag()` - Tag cache entries
- `revalidateTag()` - Invalidate by tags
- `revalidatePath()` - Invalidate by path
- Cache Components and PPR

## Supported Backends

All backends are **integration tested** with Next.js 16+ in our CI pipeline, ensuring reliability for production use.

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
  experimental: {
    cacheComponents: true,
    cacheHandlers: {
      default: "./data-cache-handler.mjs",
    },
  },
};
```

**Environment Variables:**
- `REDIS_URL` - Redis connection URL (for redis/valkey)
- `REDIS_PASSWORD` - Redis password (fallback for all cache types)
- `VALKEY_URL` - Valkey connection URL (alternative to REDIS_URL)
- `ELASTICACHE_ENDPOINT` - ElastiCache cluster endpoint
- `ELASTICACHE_PORT` - Port (default: 6379)
- `ELASTICACHE_TLS` - Enable TLS (default: true)
- `ELASTICACHE_AUTH_TOKEN` - Auth token/password

### Advanced: Custom Configuration

Need more control? You can override any option:

```javascript
// data-cache-handler.mjs
import { createCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

export default createCacheHandler({
  type: "elasticache",
  endpoint: "my-cluster.cache.amazonaws.com",
  port: 6380,
  password: process.env.CUSTOM_TOKEN,
  keyPrefix: "myapp:",
  debug: true,
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

- [Installation & Setup](./docs/installation.md)
- [Usage Examples](./docs/usage.md)
- [API Reference](./docs/api-reference.md)
- [Redis Configuration](./docs/redis.md)
- [Contributing](./CONTRIBUTING.md)

## Development

```bash
git clone https://github.com/mrjasonroy/cache-components-cache-handler
cd cache-components-cache-handler
pnpm install
pnpm build
pnpm test
```

See [docs/development.md](./docs/development.md) for details.

## Contributing

This project is AI-friendly and contributor-friendly.

- **For AI Agents:** See [CLAUDE.md](./CLAUDE.md) for instructions
- **For Humans:** See [CONTRIBUTING.md](./CONTRIBUTING.md)

## For Maintainers

Publishing and release documentation:

- [Automated Releases](./docs/publishing/AUTOMATED_RELEASE.md) - Automated release workflow
- [Prerelease Versions](./docs/publishing/PRERELEASE.md) - Alpha, beta, and RC releases
- [Release Checklist](./docs/publishing/RELEASE.md) - Complete release process

## License

MIT © [Jason Roy](https://github.com/mrjasonroy)

## Acknowledgments

Inspired by [@fortedigital/nextjs-cache-handler](https://github.com/fortedigital/nextjs-cache-handler)
