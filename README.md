# Cache Components Cache Handler

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
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](./apps/e2e-test-app)

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

## Scope

This package's main API is handlers for Next.js's **`cacheHandlers`** (plural) config — the cache
behind `"use cache"`, `"use cache: remote"`, `cacheLife()`, `cacheTag()`, `revalidateTag()`,
`updateTag()` and `revalidatePath()` under Cache Components.

The singular **`cacheHandler`** config is separate: in Next.js 16 it covers ISR pages, route handler
responses and optimized images, and it is not used by `"use cache"`. Left unset, Next uses its
default per-instance cache for those, which is **not shared across instances**. The package also
exports ISR handlers for it (`RedisCacheHandler`, `MemoryCacheHandler`, `CompositeHandler`); see
[ISR handlers](#isr-handlers) for their current limits, or bring your own (see
[Using your own ISR `cacheHandler`](#using-your-own-isr-cachehandler-alongside-this-package)).

## Supported Backends

All backends are **integration tested** with Next.js 16+ in CI so you can trust a release tag.

| Backend | Use Case | Key Features |
|---------|----------|--------------|
| **Memory** | Development, Single-instance | Zero config, fast, no external dependencies |
| **Redis** | Production, Distributed | Industry standard, high performance, cluster-safe (single-key commands only) |
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

#### Options

| Option | Default | Applies to | What it does |
|--------|---------|------------|--------------|
| `type` | (required) | all | `"memory"`, `"redis"`, `"valkey"` or `"elasticache"` |
| `url` | `REDIS_URL` / `VALKEY_URL` | redis, valkey | Connection URL |
| `endpoint` / `port` | `ELASTICACHE_ENDPOINT` / `ELASTICACHE_PORT`, `6379` | elasticache | Host and port |
| `tls` | `true` for elasticache, else `false` | redis family | Use TLS |
| `password` | `ELASTICACHE_AUTH_TOKEN` / `REDIS_PASSWORD` | redis family | Auth token or password |
| `keyPrefix` | `"nextjs:data-cache:"` | redis family | Prefix for entry keys |
| `tagPrefix` | `"nextjs:tags:"` | redis family | Prefix for tag records |
| `commandTimeout` | `2000` (ms) | redis family | A command with no reply in time fails and the read is a cache miss, so a slow or unreachable Redis can't hold up renders |
| `defaultTTL` | `86400` (s) | redis family | TTL for entries without a finite `expire` |
| `tagTTL` | `31622400` (s, 366 days) | redis family | TTL for tag revalidation records, refreshed on each revalidation; entry TTLs are capped at it |
| `errorLogIntervalMs` | `60000` | redis family | Redis errors are always logged, at most once per operation per interval |
| `suppressIsrWarning` | `false` | redis family | Turns off the one-time production warning about a missing shared ISR `cacheHandler` |
| `maxSize` | 100 MB | memory | Memory budget |
| `debug` | `false` | all | Debug logging |

The client created by `createCacheHandler` reconnects forever with backoff capped at 5s and
fails a command after one retry, so a Redis outage gives cache misses instead of hung requests.

### Advanced: Bring Your Own Redis Client

To share a connection or use Sentinel/Cluster, pass your own client. The data
cache handler expects a **node-redis-style** client; node-redis works directly,
and ioredis is wrapped with `createIoredisAdapter`:

```javascript
// ioredis (wrap with the adapter)
import Redis from "ioredis";
import {
  createRedisDataCacheHandler,
  createIoredisAdapter,
} from "@mrjasonroy/cache-components-cache-handler";

const redis = new Redis(process.env.REDIS_URL);
export default createRedisDataCacheHandler({ redis: createIoredisAdapter(redis) });
```

A client you bring doesn't get the resilience settings above. Set them yourself, for ioredis
`retryStrategy`, `maxRetriesPerRequest: 1` and `commandTimeout`, and attach an `"error"`
listener so a lost connection doesn't crash the process.

See [docs/redis.md](./docs/redis.md) for node-redis, Sentinel, and Cluster examples.

## ISR handlers

16.5.0 removed the ISR `cacheHandler` exports (`MemoryCacheHandler`, `RedisCacheHandler`,
`CompositeHandler`, `createMemoryCacheHandler`, the ISR helpers and types). That broke builds that
imported them under a `^16.x` range, so **16.5.1 restores them unchanged**, along with the
`isrHandlerPath` option of `createCacheConfig` / `createCacheConfigWithProfiles`. If you pinned
16.5.0 and removed `cacheHandler`, you can put it back.

**Known limits on Next 16** (being fixed): these handlers implement a Next 14-era contract, so
`revalidateTag` does not invalidate ISR entries, and entries are stored without a TTL. They do
share ISR pages across instances. `createCacheHandler` logs a one-time production reminder about
ISR when it creates a Redis/Valkey/ElastiCache handler, because it cannot see your `next.config`;
pass `suppressIsrWarning: true` once a shared ISR `cacheHandler` is configured (or if you run a
single instance).

### Using your own ISR `cacheHandler` alongside this package

`cacheHandler` (singular, ISR) and `cacheHandlers` (plural, `"use cache"`) are independent settings,
so you can point the first at your own shared handler and the second at this package:

```javascript
// next.config.mjs
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export default {
  cacheComponents: true,
  // Your own shared ISR handler (ISR pages, route handler responses, optimized images)
  cacheHandler: require.resolve("./isr-cache-handler.mjs"),
  // This package, for "use cache" and "use cache: remote"
  cacheHandlers: {
    default: require.resolve("./data-cache-handler.mjs"),
    remote: require.resolve("./data-cache-handler.mjs"),
  },
  cacheMaxMemorySize: 0,
};
```

```javascript
// data-cache-handler.mjs
import { createCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

export default createCacheHandler({
  type: "redis",
  suppressIsrWarning: true, // a shared ISR cacheHandler is configured in next.config
});
```

See Next's [`cacheHandler` docs](https://nextjs.org/docs/app/api-reference/config/next-config-js/incrementalCacheHandlerPath)
for the ISR handler contract.

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
- [Valkey & ElastiCache Setup](./docs/redis.md#valkey) *(coming from same guide)*
- [Contributing](./CONTRIBUTING.md)

## CI & Test Matrix

| Workflow | What it Verifies |
|----------|------------------|
| `.github/workflows/ci.yml` | Biome lint + format check, typecheck, Vitest, and Playwright e2e suites against Memory, Redis, Valkey, and ElastiCache-mode backends |
| `.github/workflows/nextjs-canary-test.yml` | Daily compatibility runs against Next.js canary/rc/latest to catch upstream breakage |
| `.github/workflows/nextjs-version-check.yml` | Nightly scan for new Next.js releases, opens PRs to bump peer deps |
| `.github/workflows/publish.yml` | Trusted publishing with provenance – release tags must pass the full matrix before npm sees them |

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

Forked from/Inspired by [@fortedigital/nextjs-cache-handler](https://github.com/fortedigital/nextjs-cache-handler), but focusing only on supporting Next.js 16+ and the new caching system.
