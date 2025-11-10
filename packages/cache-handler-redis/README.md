# @mrjasonroy/better-nextjs-cache-handler-redis

Redis cache handler for Next.js 16+ with full support for both ISR caching and Cache Components ("use cache" directive).

## Features

- ✅ **Dual Handler Support**: Works with both ISR (`cacheHandler`) and Cache Components (`cacheHandlers`)
- ✅ **Next.js 16+ APIs**: Full support for `cacheLife()`, `cacheTag()`, and all cache profiles
- ✅ **Tag-based Revalidation**: Efficient cache invalidation with Redis Sets
- ✅ **TTL Management**: Automatic expiration with configurable defaults
- ✅ **Production Ready**: Works with Redis, AWS ElastiCache, and Valkey
- ✅ **Connection Pooling**: Uses ioredis for robust connection management
- ✅ **TypeScript**: Full type safety with strict mode
- ✅ **Debug Logging**: Optional verbose logging for development

## Installation

```bash
npm install @mrjasonroy/better-nextjs-cache-handler-redis ioredis
# or
pnpm add @mrjasonroy/better-nextjs-cache-handler-redis ioredis
# or
yarn add @mrjasonroy/better-nextjs-cache-handler-redis ioredis
```

## Usage

### Option 1: Cache Components Only (Recommended for Next.js 16+)

If you're using Next.js 16+ with Cache Components (`"use cache"`), use the data cache handler:

**1. Create `data-cache-handler.mjs` in your project root:**

```javascript
import { createClient } from 'redis';
import { createRedisDataCacheHandler } from '@mrjasonroy/better-nextjs-cache-handler-redis';

// Create Redis client
const redis = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

await redis.connect();

// Export the data cache handler
export default createRedisDataCacheHandler({
  redis,
  keyPrefix: 'myapp:cache:',
  tagPrefix: 'myapp:tags:',
  defaultTTL: 86400, // 24 hours
  debug: process.env.NODE_ENV === 'development'
});
```

**2. Configure `next.config.js`:**

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  cacheComponents: true,
  cacheHandlers: {
    default: require.resolve('./data-cache-handler.mjs'),
    remote: require.resolve('./data-cache-handler.mjs')
  }
};

export default nextConfig;
```

**3. Use in your components:**

```typescript
import { cacheLife, cacheTag } from 'next/cache';

async function getUserData(id: string) {
  'use cache';
  cacheLife('minutes'); // or 'seconds', 'hours', 'days', 'weeks', 'max'
  cacheTag(`user-${id}`);

  const response = await fetch(`https://api.example.com/users/${id}`);
  return response.json();
}
```

### Option 2: ISR Cache Handler (Legacy/Traditional)

For traditional ISR caching (pages directory or without Cache Components):

**1. Create `cache-handler.mjs` in your project root:**

```javascript
import { RedisCacheHandler } from '@mrjasonroy/better-nextjs-cache-handler-redis';

export default class NextCacheHandler extends RedisCacheHandler {
  constructor(options) {
    super({
      ...options,
      redis: process.env.REDIS_URL || 'redis://localhost:6379',
      keyPrefix: 'nextjs:cache:',
      tagPrefix: 'nextjs:tags:',
      defaultTTL: 3600,
      debug: process.env.NODE_ENV === 'development'
    });
  }
}
```

**2. Configure `next.config.js`:**

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  cacheHandler: require.resolve('./cache-handler.mjs')
};

export default nextConfig;
```

**3. Use with revalidation:**

```typescript
export const revalidate = 3600; // 1 hour

export default async function Page() {
  const data = await fetch('https://api.example.com/data', {
    next: { tags: ['api-data'] }
  });
  return <div>{/* ... */}</div>;
}
```

### Option 3: Both Handlers (Full Support)

You can use both handlers if you need ISR and Cache Components:

```javascript
// next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  // ISR cache handler
  cacheHandler: require.resolve('./cache-handler.mjs'),

  // Cache Components handlers
  cacheComponents: true,
  cacheHandlers: {
    default: require.resolve('./data-cache-handler.mjs'),
    remote: require.resolve('./data-cache-handler.mjs')
  }
};

export default nextConfig;
```

## Configuration

### ISR Cache Handler Options

```typescript
interface RedisCacheHandlerOptions {
  /**
   * Redis connection options (ioredis)
   * Can be a URL string or RedisOptions object
   */
  redis?: string | RedisOptions;

  /**
   * Key prefix for all cache entries
   * @default "nextjs:cache:"
   */
  keyPrefix?: string;

  /**
   * Key prefix for tag tracking
   * @default "nextjs:tags:"
   */
  tagPrefix?: string;

  /**
   * Default TTL in seconds for entries without explicit revalidate
   * @default undefined (no expiration)
   */
  defaultTTL?: number;

  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;
}
```

### Data Cache Handler Options

```typescript
interface RedisDataCacheHandlerOptions {
  /**
   * Redis client instance (ioredis or node-redis)
   */
  redis: RedisClient;

  /**
   * Key prefix for all cache entries
   * @default "nextjs:data-cache:"
   */
  keyPrefix?: string;

  /**
   * Key prefix for tag manifest
   * @default "nextjs:tags:"
   */
  tagPrefix?: string;

  /**
   * Default TTL for cache entries in seconds
   * @default 86400 (24 hours)
   */
  defaultTTL?: number;

  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;
}
```

## Cache Profiles

When using Cache Components, you can use predefined cache profiles with `cacheLife()`:

```typescript
import { cacheLife } from 'next/cache';

async function getData() {
  'use cache';
  cacheLife('seconds');  // Very short-lived cache
  cacheLife('minutes');  // Short-lived cache
  cacheLife('hours');    // Medium-lived cache
  cacheLife('days');     // Long-lived cache
  cacheLife('weeks');    // Very long-lived cache
  cacheLife('max');      // Maximum cache duration

  // Or use custom profiles defined in your config
  cacheLife('product-data');
}
```

## Tag-based Revalidation

Both handlers support tag-based revalidation:

```typescript
// Mark cached content with tags
'use cache';
cacheTag('blog-posts', `post-${id}`);

// Revalidate from Server Actions or Route Handlers
import { revalidateTag } from 'next/cache';

export async function updatePost(id: string) {
  'use server';

  // Update your data...

  // Revalidate the cache
  revalidateTag(`post-${id}`);
  revalidateTag('blog-posts');
}
```

## Redis Configuration

### Basic Redis (Development)

```javascript
import { createClient } from 'redis';

const redis = createClient({
  url: 'redis://localhost:6379'
});

await redis.connect();
```

### Redis with Authentication

```javascript
const redis = createClient({
  url: 'redis://username:password@redis.example.com:6379'
});

await redis.connect();
```

### AWS ElastiCache

```javascript
const redis = createClient({
  socket: {
    host: 'your-cluster.cache.amazonaws.com',
    port: 6379
  },
  // Optional: Use TLS for encrypted connections
  tls: {}
});

await redis.connect();
```

### Valkey (Redis-compatible)

```javascript
const redis = createClient({
  url: 'valkey://your-valkey-host:6379'
});

await redis.connect();
```

### Connection Pooling with ioredis

For the ISR handler, you can pass ioredis options directly:

```javascript
import { RedisCacheHandler } from '@mrjasonroy/better-nextjs-cache-handler-redis';

export default class NextCacheHandler extends RedisCacheHandler {
  constructor(options) {
    super({
      ...options,
      redis: {
        host: 'redis.example.com',
        port: 6379,
        password: process.env.REDIS_PASSWORD,
        db: 0,
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: false
      }
    });
  }
}
```

## Performance Considerations

### Key Design

The handlers use efficient key patterns:

- **ISR Cache**: `{keyPrefix}{cacheKey}` (e.g., `nextjs:cache:/api/users`)
- **Data Cache**: `{keyPrefix}{cacheKey}` (e.g., `nextjs:data-cache:xyz123`)
- **Tag Manifest**: `{tagPrefix}{tag}` (e.g., `nextjs:tags:user-123`)
- **Tag Keys Set**: `{tagPrefix}{tag}:keys` (e.g., `nextjs:tags:user-123:keys`)

### Memory Usage

- Each cache entry stores metadata (tags, timestamps, TTL)
- ReadableStreams are serialized as base64-encoded buffers
- Consider setting `defaultTTL` to prevent unbounded growth

### Redis Commands Used

- **GET/SET**: Primary cache operations
- **SETEX**: Cache with TTL
- **DEL**: Cache invalidation
- **SADD/SMEMBERS**: Tag tracking
- **HGET/HSET/HGETALL**: Tag manifest operations
- **PIPELINE**: Batch operations for efficiency

## Debugging

Enable debug logging to see cache operations:

```javascript
export default createRedisDataCacheHandler({
  redis,
  debug: true
});
```

This will log:

```
[RedisDataCache]: get xyz123 found { tags: ['user-1'], timestamp: 1234567890, revalidate: 3600 }
[RedisDataCache]: set xyz123 done { ttl: 3600 }
[RedisDataCache]: updateTags { tags: ['user-1'], timestamp: 1234567890 }
```

For the ISR handler:

```
[RedisCacheHandler] GET nextjs:cache:/api/data HIT
[RedisCacheHandler] SET nextjs:cache:/api/data TTL=3600s kind=FETCH
[RedisCacheHandler] revalidateTag user-1 deleted 5 entries
```

## Error Handling

Both handlers gracefully handle Redis errors:

- Connection failures return cache misses (no errors thrown)
- Set operations fail silently (logged if debug enabled)
- Revalidation errors are logged but don't crash your app

## Migration Guide

### From In-Memory to Redis

1. Install the package: `pnpm add @mrjasonroy/better-nextjs-cache-handler-redis ioredis`
2. Set up Redis (local, ElastiCache, or Valkey)
3. Replace your cache handler files with Redis versions
4. Update `next.config.js` with the new handler paths
5. Deploy - cache will be empty initially but will populate on first requests

### From @neshca/cache-handler

Our Redis handler is inspired by and compatible with the `@neshca/cache-handler` architecture. Key differences:

- ✅ Better TypeScript support with strict mode
- ✅ Simpler API with sensible defaults
- ✅ Full Next.js 16+ Cache Components support
- ✅ Both ISR and data cache in one package

## Examples

See the `/apps/e2e-test-app` directory in the repository for complete examples of:

- Cache Components with Redis data cache handler
- ISR with Redis cache handler
- Tag-based revalidation patterns
- Custom cache profiles
- E2E test suite

## License

MIT

## Contributing

Issues and PRs welcome at https://github.com/mrjasonroy/better-nextjs-cache-handler

## Credits

Built with inspiration from [@neshca/cache-handler](https://github.com/caching-tools/next-shared-cache) by [Igor Ilyichev](https://github.com/igorilyichev).
