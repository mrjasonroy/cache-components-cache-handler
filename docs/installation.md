# Installation & Setup

## Prerequisites

- Node.js 22.3+
- Next.js 16+ with `cacheComponents: true`
- Redis 7+ (6.2 at the least, with scripting allowed), Valkey or AWS ElastiCache for
  multi-instance deployments. Nothing is needed for dev or a single instance.

## Install

<!-- rc: drop "@rc" (and the note below) once 16.4.3 is the npm latest release -->
```bash
npm install @mrjasonroy/cache-components-cache-handler@rc ioredis
```

`withCache` is new in 16.4.3, currently a release candidate on the `rc` tag. Drop `@rc` once
16.4.3 is the latest release.

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
set any of those yourself: `withCache` throws if the config already has `cacheHandlers`, or
`cacheHandler` unless you pass `pages: false`. The [What goes where](./how-it-works.md#what-goes-where) table says what each one does.

`nextConfig` can also be a config function, `(phase, { defaultConfig }) => config`, sync or
async. `withCache` then returns an async function that applies the same settings to its result.
The options (`useCache`, `pages`, `handlers`, `memory`) are in the [README](../README.md#withcachenextconfig-options)
and the [API reference](./api-reference.md#withcachenextconfig-options).

The handler files ship inside the package, so there are no handler files to write. For your own
client or timeouts, see [Custom handlers](./custom-handlers.md).

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

## Environment variables

Next loads handler files by path. It cannot pass them objects from `next.config`, and a standalone
`server.js` never runs `next.config` at all. So the built-in handlers read their runtime settings
from the environment, the same under `next start`, standalone and Docker. The one exception is
`withCache`'s `memory`, which reaches the handlers only where the serving process loads
`next.config` (`next dev`, `next start`); use the `CACHE_MEMORY_*` variables for standalone.

| Variable | Default | Meaning |
|---|---|---|
| `REDIS_URL` (or `VALKEY_URL`) | unset → memory only | `redis://` or `rediss://` URL, password included. |
| `REDIS_PASSWORD` | — | Password when the URL has none. |
| `ELASTICACHE_ENDPOINT`, `ELASTICACHE_PORT`, `ELASTICACHE_AUTH_TOKEN` | port `6379` | Host form, used when no URL is set. TLS is on. |
| `ELASTICACHE_TLS` | `true` | `false` turns TLS off for the host form. |
| `CACHE_KEY_PREFIX` | `nextjs:` | Prefix for every key. Use it to share one Redis between apps. |
| `CACHE_REDIS` | `on` | `off` (or `0`, `false`, `no`) forces memory everywhere, even with a URL set. A kill switch for every backend: it turns off Valkey and ElastiCache too, whatever variable set the URL. |
| `CACHE_DEBUG` | unset | `1` (or `true`) logs hits, misses, writes (with each value's size in bytes) and state changes. It never logs the URL. |
| `CACHE_COMPRESSION` | `on` | Entries of 16 KB and more are stored Brotli-compressed (usually 5 to 15 times smaller). `off` (or `0`, `false`, `no`) stores them uncompressed. Either way, both forms are read. Entries over 64 MB are always stored uncompressed. |
| `CACHE_MEMORY_HEAP_PERCENT` | `10` | The in-process cache budget as a share of V8's heap limit (a little above `--max-old-space-size`), in percent: more than 0 and less than 100. See [Memory](./operations.md#memory). |
| `CACHE_MEMORY_MAX_MIB` | unset | The in-process cache budget in MiB, more than 0. Wins over `CACHE_MEMORY_HEAP_PERCENT`; `withCache`'s `memory` option wins over both. An invalid value makes cache calls throw, naming the variable. |

There are no tuning variables for timeouts or TTLs: the defaults are the product. If you need
different ones, write a [custom handler file](./custom-handlers.md).

Redis is used whenever a URL or endpoint is set, except during `next build`, on the edge runtime
and with `CACHE_REDIS=off`. `next build` never connects to Redis, whatever the environment says.
If a dev `.env` file carries `REDIS_URL`, the dev server will use Redis; remove it there or set
`CACHE_REDIS=off`.

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

## Upgrading from 16.4.2

See [Migrating](./migrating.md).
