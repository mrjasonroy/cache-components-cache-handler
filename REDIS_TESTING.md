# Redis Cache Handler Testing

This document explains how to test the cache handlers with Redis.

## Overview

The e2e test app is now **cache-agnostic** and can run with different cache backends:
- **Memory** (default) - In-memory cache for development
- **Redis** - Distributed cache for production

The same e2e tests run against both backends to ensure compatibility.

## Quick Start

### 1. Start Redis (Docker)

```bash
# Start Redis container
pnpm docker:up

# Verify Redis is running
docker ps | grep redis

# View Redis logs
pnpm docker:logs
```

### 2. Run Tests with Redis

```bash
# Run all e2e tests with Redis
pnpm test:e2e:redis

# This is equivalent to:
# 1. pnpm docker:up (starts Redis)
# 2. CACHE_HANDLER=redis pnpm --filter e2e-test-app test:e2e
```

### 3. Run Tests with Memory (default)

```bash
# Run all e2e tests with memory cache
pnpm test:e2e

# No CACHE_HANDLER env var = memory cache
```

## Manual Testing

### Build and Run with Redis

```bash
# Build the e2e app with Redis cache handler
cd apps/e2e-test-app
CACHE_HANDLER=redis pnpm build

# Start the production server
CACHE_HANDLER=redis pnpm start

# Open http://localhost:3000
```

### Build and Run with Memory

```bash
# Build with memory cache (default)
pnpm build

# Start the production server
pnpm start
```

## How It Works

### Environment Variables

- `CACHE_HANDLER` - Selects which cache backend to use
  - `"memory"` (default) - Uses `createMemoryDataCacheHandler()`
  - `"redis"` - Uses `createRedisDataCacheHandler()`
- `REDIS_URL` - Redis connection URL (default: `redis://localhost:6379`)
- `CACHE_DEBUG` - Enable debug logging (`"true"` or `"false"`)

### Cache Handler Files

**`apps/e2e-test-app/data-cache-handler.mjs`**

This file conditionally loads the appropriate cache handler based on `CACHE_HANDLER`:

```javascript
const cacheType = process.env.CACHE_HANDLER || "memory";

if (cacheType === "redis") {
  // Create Redis client and handler
  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  export default createRedisDataCacheHandler({ redis, ... });
} else {
  // Create memory handler
  export default createMemoryDataCacheHandler({ ... });
}
```

### Next.js Configuration

**`apps/e2e-test-app/next.config.mjs`**

```javascript
cacheComponents: true,
cacheHandlers: {
  default: require.resolve('./data-cache-handler.mjs'),
  remote: require.resolve('./data-cache-handler.mjs')
}
```

The handler file is evaluated at build time and server start, loading the appropriate cache backend.

## Test Coverage

All e2e tests run against both backends:

✅ **Cache Components**
- Basic caching with "use cache"
- cacheLife() profiles (seconds, minutes, hours, days, weeks, max)
- cacheTag() and tag-based revalidation
- Dynamic and static routes
- Nested cache behavior
- Mixed cache strategies

✅ **Fetch Caching**
- fetch() with "use cache"
- fetch() without "use cache" (no caching with cacheComponents)

✅ **Revalidation**
- revalidateTag() from Server Actions
- Time-based revalidation
- Path-based revalidation

## Redis-Specific Features

When using Redis, you get:

1. **Persistence** - Cache survives server restarts
2. **Distribution** - Multiple Next.js instances share the same cache
3. **Scalability** - Handles large cache sizes
4. **Production-ready** - Works with AWS ElastiCache, Valkey, etc.

## Debugging

### View Cache in Redis

```bash
# Connect to Redis CLI
docker exec -it nextjs-cache-redis redis-cli

# List all cache keys
KEYS e2e:cache:*

# List all tag keys
KEYS e2e:tags:*

# Get a specific cache entry
GET e2e:cache:some-key

# View all keys with a tag
SMEMBERS e2e:tags:my-tag:keys

# View tag metadata
HGETALL e2e:tags:my-tag
```

### Enable Debug Logging

```bash
# Run with debug logs
CACHE_DEBUG=true CACHE_HANDLER=redis pnpm start
```

You'll see logs like:

```
[DataCacheHandler] Using cache type: redis
[Redis] Connected successfully
[RedisDataCache]: get xyz123 found { tags: ['user-1'], timestamp: 1234567890, revalidate: 3600 }
[RedisDataCache]: set abc456 done { ttl: 3600 }
```

### Use Redis Commander (GUI)

Docker Compose includes Redis Commander on port 8081:

```bash
# Start services
pnpm docker:up

# Open http://localhost:8081
```

Browse your cache visually!

## CI/CD

To run tests in CI with Redis:

```yaml
# .github/workflows/test.yml
- name: Start Redis
  run: docker compose up -d

- name: Run e2e tests with Redis
  run: pnpm test:e2e:redis
  env:
    REDIS_URL: redis://localhost:6379
```

## Cleanup

```bash
# Stop Redis
pnpm docker:down

# Stop and remove volumes
docker compose down -v
```

## Next Steps

1. ✅ Memory cache handler - Working
2. ✅ Redis cache handler - Working
3. ⏳ ElastiCache testing (AWS)
4. ⏳ Valkey testing
5. ⏳ Performance benchmarks

## Troubleshooting

### "Cannot connect to Redis"

- Ensure Docker is running: `docker ps`
- Start Redis: `pnpm docker:up`
- Check logs: `pnpm docker:logs`

### "Tests timeout"

- Make sure you built in production mode: `CACHE_HANDLER=redis pnpm build`
- Verify server is running: `CACHE_HANDLER=redis pnpm start`
- Check Redis connection in server logs

### "Cache not persisting"

- Verify `CACHE_HANDLER=redis` is set
- Check Redis logs for errors
- Ensure Redis is actually running: `docker ps | grep redis`
