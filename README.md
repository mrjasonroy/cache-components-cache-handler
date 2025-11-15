# Cache Components Cache Handler

Cache handler for Next.js 16+ with support for Cache Components and "use cache" directive.

[![npm version](https://badge.fury.io/js/@mrjasonroy%2Fcache-components-cache-handler.svg)](https://www.npmjs.com/package/@mrjasonroy/cache-components-cache-handler)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![Next.js 16+](https://img.shields.io/badge/Next.js-16%2B-black)](https://nextjs.org/)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](./apps/e2e-test-app)

## What This Does

Implements Next.js 16+ caching APIs:
- `"use cache"` directive
- `cacheLife()` - Configure cache lifetime
- `cacheTag()` - Tag cache entries
- `revalidateTag()` - Invalidate by tags
- `revalidatePath()` - Invalidate by path
- Cache Components and PPR

Backends:
- Memory (development)
- Redis (production, distributed)
- Valkey (Redis-compatible)

## Install

```bash
npm install @mrjasonroy/cache-components-cache-handler
```

## Quick Start

### Memory (Development)

```javascript
// data-cache-handler.mjs
import { createMemoryDataCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

export default createMemoryDataCacheHandler({
  maxSize: 100 * 1024 * 1024, // 100MB
});
```

```javascript
// next.config.js
module.exports = {
  experimental: {
    cacheComponents: true,
    cacheHandlers: {
      default: require.resolve("./data-cache-handler.mjs"),
    },
  },
};
```

### Redis (Production)

```bash
npm install ioredis
```

```javascript
// data-cache-handler.mjs
import Redis from "ioredis";
import { createRedisDataCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

export default createRedisDataCacheHandler({
  redis,
  keyPrefix: "myapp:cache:",
  tagPrefix: "myapp:tags:",
});
```

```javascript
// next.config.js
export default {
  cacheComponents: true,
  cacheHandlers: {
    default: "./data-cache-handler.mjs",
  },
};
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

- [First Publish](./docs/publishing/FIRST_PUBLISH.md) - One-time setup for npm
- [Automated Releases](./docs/publishing/AUTOMATED_RELEASE.md) - Automated release workflow
- [Prerelease Versions](./docs/publishing/PRERELEASE.md) - Alpha, beta, and RC releases
- [Release Checklist](./docs/publishing/RELEASE.md) - Complete release process

## License

MIT © [Jason Roy](https://github.com/mrjasonroy)

## Acknowledgments

Inspired by [@fortedigital/nextjs-cache-handler](https://github.com/fortedigital/nextjs-cache-handler)
