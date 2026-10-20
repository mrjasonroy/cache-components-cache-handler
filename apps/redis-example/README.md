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

### 1. One line of config

`next.config.mjs` is `withCache({ cacheComponents: true }, { useCache: "redis" })`. There are no
handler files to write. Pages, `"use cache"` and `"use cache: remote"` all go to Redis when
`REDIS_URL` is set, and stay in memory when it is not.

### 2. Cache Usage During Serve

`next build` never connects to Redis. Entries are written the first time each page or cached
function runs under `next start`, and every instance pointed at the same Redis shares them:

```bash
pnpm start:redis
# First load pays the 1-second delay; reloads are served from Redis
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

# 2. Build the app (no Redis needed)
pnpm build

# 3. Start the app against Redis (REDIS_URL defaults to redis://localhost:6379)
pnpm start:redis

# 4. Stop Redis when done
pnpm docker:down
```

## Verify Cache in Redis

```bash
# List all cache keys
docker exec -it redis-example-redis-1 redis-cli KEYS "example:*"

# Entries are <prefix><buildId>:page:* and <prefix><buildId>:data:* strings. Tags live in two
# keys: <prefix>tags, a hash of every tag record, and <prefix>tag-index, a sorted set of the same
# tags scored by last update time (ms)
docker exec -it redis-example-redis-1 redis-cli HGETALL example:tags
docker exec -it redis-example-redis-1 redis-cli ZRANGE example:tag-index 0 -1 WITHSCORES

# Clear all cache
docker exec -it redis-example-redis-1 redis-cli FLUSHDB
```

## Key Files

- `next.config.mjs` - Enables Cache Components and wires every cache with `withCache`
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
         ├─ Build time: Pre-renders pages in memory, never touches Redis
         │
         └─ Runtime: Reads and writes Redis, shared by every instance

┌──────────────────┐
│   Redis Cache    │
│ example:<build>:*│
│ example:tags     │
│ example:tag-index│
└──────────────────┘
```

## Production Notes

In production:
- Use managed Redis (AWS ElastiCache, Upstash, etc.)
- Set `REDIS_URL` environment variable
- Set `CACHE_KEY_PREFIX` if several apps share one Redis
- Monitor Redis memory usage
- Consider Redis Sentinel or Cluster for high availability

## Learn More

- [Main Documentation](../../README.md)
- [Redis Configuration](../../docs/redis.md)
- [Installation Guide](../../docs/installation.md)
