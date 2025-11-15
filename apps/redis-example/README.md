# Redis Cache Example

Minimal example demonstrating Next.js 16 "use cache" directive with Redis.

## Quick Start

```bash
# From repository root
cd apps/redis-example

# Start Redis + Build + Run (one command!)
pnpm demo
```

Then open [http://localhost:3000](http://localhost:3000)

## What This Demonstrates

### 1. Cache Population During Build

When you run `pnpm build`, Next.js pre-renders static pages and **populates the Redis cache**:

```bash
pnpm build
# You'll see cache operations in the build output
```

### 2. Cache Usage During Serve

When you run `pnpm start`, the app serves cached data from Redis instantly:

```bash
pnpm start
# Cached data loads immediately (no 1-second delay)
```

### 3. Cache Invalidation

The app demonstrates tag-based revalidation:
- Visit `/products`
- Click "Revalidate Products Cache"
- Refresh the page - timestamp updates

## Manual Steps

If you want to run each step separately:

```bash
# 1. Start Redis
pnpm docker:up

# 2. Build the app (populates cache)
pnpm build

# 3. Start the app (serves from cache)
pnpm start

# 4. Stop Redis when done
pnpm docker:down
```

## Verify Cache in Redis

```bash
# List all cache keys
docker exec -it redis-example-redis-1 redis-cli KEYS "example:*"

# View a specific cache entry
docker exec -it redis-example-redis-1 redis-cli GET "example:cache:..."

# Clear all cache
docker exec -it redis-example-redis-1 redis-cli FLUSHDB
```

## Key Files

- `data-cache-handler.mjs` - Redis cache handler configuration
- `next.config.mjs` - Enables Cache Components and configures handler
- `docker-compose.yml` - Redis setup
- `app/page.tsx` - Homepage with cached data
- `app/products/page.tsx` - Example with tag-based revalidation

## How It Works

1. **`"use cache"` directive** - Marks functions for caching
2. **`cacheLife()`** - Sets cache duration (minutes, hours, days, etc.)
3. **`cacheTag()`** - Tags cache entries for selective invalidation
4. **`revalidateTag()`** - Invalidates specific cache tags
5. **Redis storage** - All cache data stored in Redis, shared across instances

## Architecture

```
┌──────────────────┐
│   Next.js App    │
│  (use cache)     │
└────────┬─────────┘
         │
         ├─ Build time: Pre-renders pages, writes to Redis
         │
         └─ Runtime: Reads from Redis, serves instantly

┌──────────────────┐
│   Redis Cache    │
│ example:cache:*  │
│ example:tags:*   │
└──────────────────┘
```

## Production Notes

In production:
- Use managed Redis (AWS ElastiCache, Upstash, etc.)
- Set `REDIS_URL` environment variable
- Configure appropriate TTLs for your use case
- Monitor Redis memory usage
- Consider Redis Sentinel or Cluster for high availability

## Learn More

- [Main Documentation](../../README.md)
- [Redis Configuration](../../docs/redis.md)
- [Installation Guide](../../docs/installation.md)
