# Quick Start: Run Tests with Redis

## Prerequisites

1. **Start Docker Desktop** (required for Redis)

## Run Tests with Redis

Once Docker is running, execute:

```bash
# Option 1: Use the convenience script (starts Docker + runs tests)
pnpm test:e2e:redis

# Option 2: Manual steps
pnpm docker:up              # Start Redis
pnpm docker:logs            # Verify Redis is running (Ctrl+C to exit)
cd apps/e2e-test-app
CACHE_HANDLER=redis pnpm build
CACHE_HANDLER=redis pnpm start &
CACHE_HANDLER=redis pnpm test:e2e
```

## Verify Redis is Running

```bash
# Check Docker containers
docker ps | grep redis

# You should see:
# nextjs-cache-redis (port 6379)
# nextjs-cache-redis-commander (port 8081)
```

## View Cache in Redis Commander

Open http://localhost:8081 to browse cache entries visually!

## Run Tests with Memory (for comparison)

```bash
cd apps/e2e-test-app
pnpm build
pnpm start &
pnpm test:e2e
```

## What to Expect

All **44-45 e2e tests** should pass with Redis, including:

✅ Basic "use cache" caching
✅ cacheLife() profiles (seconds, minutes, hours, days, weeks, max)
✅ cacheTag() and revalidateTag()
✅ Dynamic and static routes
✅ Nested cache behavior
✅ Mixed cache strategies
✅ Fetch with "use cache"
✅ Revalidation timing

## Debug Redis

```bash
# Connect to Redis CLI
docker exec -it nextjs-cache-redis redis-cli

# View all cache keys
KEYS e2e:cache:*

# View all tags
KEYS e2e:tags:*

# Get a specific entry
GET e2e:cache:some-key
```

## Cleanup

```bash
# Stop Redis
pnpm docker:down

# Stop and remove volumes
docker compose down -v
```

## Common Issues

**"Cannot connect to Redis"**
- Start Docker Desktop
- Run: `pnpm docker:up`
- Verify: `docker ps | grep redis`

**"Tests timeout"**
- Make sure Redis is running
- Ensure you built with `CACHE_HANDLER=redis`
- Check Redis logs: `pnpm docker:logs`

**"Cache not working"**
- Verify `CACHE_HANDLER=redis` env var is set
- Check data-cache-handler.mjs is loading Redis client
- Look for "[Redis] Connected successfully" in server logs
