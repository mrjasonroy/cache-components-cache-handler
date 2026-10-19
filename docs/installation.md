# Installation & Setup

## Prerequisites

- Node.js 22.3+
- Next.js 16+ with `cacheComponents: true`
- Redis 7+ (6.2 at the least, with scripting allowed), Valkey or AWS ElastiCache for
  multi-instance deployments. Nothing is needed for dev or a single instance.

## Install

```bash
npm install @mrjasonroy/cache-components-cache-handler ioredis
```

`ioredis` is only loaded when Redis is configured, so a memory-only app can leave it out.

## Configure Next.js

```js
// next.config.mjs
import { withCache } from "@mrjasonroy/cache-components-cache-handler";

export default withCache({
  cacheComponents: true,
  // ...the rest of your config
});
```

That one call sets `cacheHandler` (pages, route handlers, cached `fetch`), `cacheHandlers.default`
(`"use cache"`), `cacheHandlers.remote` (`"use cache: remote"`) and `cacheMaxMemorySize: 0`. Don't
set any of those yourself: `withCache` throws if the config already has `cacheHandler` or
`cacheHandlers`. The README's [What goes where](../README.md#what-goes-where) table says what each
one does.

The handler files ship inside the package, so there are no handler files to write. For your own
client or timeouts, see [Custom handlers](../README.md#custom-handlers).

## Point it at Redis

Set the connection in the environment of the running app, not in `next.config`. A standalone
`server.js` never runs `next.config`, so the environment is the only setting that works the same
under `next start`, standalone and Docker.

### Development and single instance

Leave `REDIS_URL` unset. Everything is cached in each process's memory.

### Redis or Valkey

```bash
REDIS_URL=redis://cache.internal:6379
# with a password and TLS:
REDIS_URL=rediss://:password@cache.internal:6380
```

`VALKEY_URL` works too, and `REDIS_PASSWORD` supplies a password when the URL has none.

### AWS ElastiCache

```bash
ELASTICACHE_ENDPOINT=master.my-cache.abc123.use1.cache.amazonaws.com
ELASTICACHE_AUTH_TOKEN=...
# ELASTICACHE_PORT=6379   (default)
# ELASTICACHE_TLS=false   (TLS is on by default)
```

A URL takes precedence over the endpoint when both are set. For cluster-mode-enabled ElastiCache,
see [Redis Cluster](./redis.md#redis-cluster).

### Other settings

| Variable | Default | Meaning |
|---|---|---|
| `CACHE_KEY_PREFIX` | `nextjs:` | Prefix for every key. Use it to share one Redis between apps. |
| `CACHE_REDIS` | `on` | `off` forces memory everywhere, even with a URL set. |
| `CACHE_DEBUG` | unset | `1` logs hits, misses, writes (with each value's size in bytes) and state changes. It never logs the URL. |

The full table is in the README under [Environment variables](../README.md#environment-variables).

`next build` never connects to Redis, whatever the environment says. If a dev `.env` file carries
`REDIS_URL`, the dev server will use Redis; remove it there or set `CACHE_REDIS=off`.

## Verify

1. Build and start with Redis configured and debug logging on:

   ```bash
   next build
   REDIS_URL=redis://localhost:6379 CACHE_DEBUG=1 next start
   ```

2. Load a page twice. The log shows `[PageCache]: set ... redis`, then `[PageCache]: get ... hit`.
3. Look at the keys:

   ```bash
   redis-cli --scan --pattern 'nextjs:*' | head
   ```

   Pages sit under `nextjs:<buildId>:page:`, `"use cache: remote"` entries under
   `nextjs:<buildId>:data:`, and tag records in the `nextjs:tags` hash, indexed by
   `nextjs:tag-index` (both appear after the first revalidation). Plain `"use cache"` values stay
   in memory unless you pass `{ useCache: "redis" }`.

A local Redis for this is one command away: `pnpm docker:up` in this repo, or
`docker run -d -p 6379:6379 redis:7-alpine`.

## Upgrading from 16.5.x

See [Migrating](../README.md#migrating) in the README.
