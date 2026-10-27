# Cache Components Cache Handler

One Redis-backed cache for a Next.js 16+ app, safe through a Redis outage: pages, route handlers
and `"use cache: remote"` shared across every instance, and `"use cache"` in each instance's
memory with revalidation shared across all of them.

[![npm version](https://badge.fury.io/js/@mrjasonroy%2Fcache-components-cache-handler.svg)](https://www.npmjs.com/package/@mrjasonroy/cache-components-cache-handler)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Next.js 16+](https://img.shields.io/badge/Next.js-16%2B-black)](https://nextjs.org/)
[![CI](https://github.com/mrjasonroy/cache-components-cache-handler/actions/workflows/ci.yml/badge.svg)](https://github.com/mrjasonroy/cache-components-cache-handler/actions/workflows/ci.yml)
[![Next.js deploy tests](https://github.com/mrjasonroy/cache-components-cache-handler/actions/workflows/next-deploy-tests.yml/badge.svg?event=pull_request)](https://github.com/mrjasonroy/cache-components-cache-handler/actions/workflows/next-deploy-tests.yml)

> [!IMPORTANT]
> **16.4.3 is a major release under a patch number.** The version follows Next.js, so it is
> numbered 16.4.3 to match Next.js 16.4.3, but it reworks the handler: `withCache`, a new page-cache
> key layout (the page cache starts cold on upgrade), memory limits, deployment-ID scoping and
> ElastiCache IAM. 16.4.2 setups keep working with deprecation warnings, and `^16.4.2` installs get
> it automatically. Read [Upgrading from 16.4.2](./docs/migrating.md) before you deploy.

## Start here

1. **Install** the release for your Next.js minor, pinned exact. For Next 16.4.x:

   ```bash
   npm install --save-exact @mrjasonroy/cache-components-cache-handler@16.4
   ```

   `@16.4` picks the newest 16.4.x and `--save-exact` pins it. Needs Node.js 22.3+.

2. **Wrap your config:**

   ```js
   // next.config.mjs
   import { withCache } from "@mrjasonroy/cache-components-cache-handler";

   export default withCache({ cacheComponents: true });
   ```

3. **Pick your setup:**

   | Setup | What to do |
   |---|---|
   | Local dev, CI, previews, one instance | Nothing. Without `REDIS_URL` everything stays in memory. |
   | Redis or Valkey | Set `REDIS_URL=redis://cache:6379` on the running app. [Installation](./docs/installation.md#point-it-at-redis) |
   | AWS ElastiCache, Serverless or cluster mode disabled | Set `ELASTICACHE_ENDPOINT` and `ELASTICACHE_AUTH_TOKEN`, or the IAM variables. [AWS ElastiCache](./docs/redis.md#aws-elasticache) |
   | AWS ElastiCache, cluster mode enabled (with or without IAM) | Your own `Cluster` in custom handler files. [Redis Cluster](./docs/redis.md#redis-cluster), [IAM on your own client](./docs/redis.md#iam-on-your-own-client) |
   | Your own client (Sentinel, other ioredis options or timeouts) | [Custom handlers](./docs/custom-handlers.md) |
   | Upgrading from 16.4.2 | [Migrating](./docs/migrating.md) |

Then keep writing `"use cache"`, `cacheTag` and `revalidateTag` as Next documents them
([examples](./docs/usage.md)).

**Setting it up with a coding agent?** Paste the prompt in [docs/agent-setup.md](./docs/agent-setup.md)
into Claude Code, Cursor or similar.

The package version follows Next.js. A range such as `^16.4.3` would also accept the 16.5
releases, which remove the APIs deprecated in 16.4.3, so pin it and upgrade the two together
([why](./docs/installation.md#install)). `ioredis` is installed with the package as an optional
dependency ([unless optionals are skipped](./docs/installation.md#install)).

## What you get

- **Pages and route handlers** (and cached `fetch`) stored in Redis, shared by every instance.
  Prerendered pages are served from the build output after a restart.
- **Next's directives, one to one.** `"use cache: remote"` entries live in Redis, shared by every
  instance. Plain `"use cache"` stays in each instance's memory, with tag invalidation shared
  through Redis. `"use cache: private"` is Next's own and never reaches a handler.
- **Revalidation across instances.** `revalidateTag`, `updateTag` and `revalidatePath` reach
  every instance and every handler.
- **Redis outage safety.** A request never fails because of the cache. Commands time out after
  1 s, and while Redis is down the app serves from per-instance memory.
- **Entries scoped by build**, so a deploy never serves the previous build's pages.
- **`next build` never connects to Redis.**

[How it works](./docs/how-it-works.md) has the details.

## Configuration

Runtime settings come from the environment of the running app. The main variables:

| Variable | Meaning |
|---|---|
| `REDIS_URL` (or `VALKEY_URL`) | `redis://` or `rediss://` URL. Unset → memory only. |
| `ELASTICACHE_ENDPOINT`, `ELASTICACHE_AUTH_TOKEN` | ElastiCache host form, TLS on. For IAM, see [IAM authentication](./docs/redis.md#iam-authentication). |
| `CACHE_KEY_PREFIX` | Prefix for every key (default `nextjs:`). |
| `CACHE_REDIS=off` | Memory everywhere, even with a URL set. |
| `CACHE_DEBUG=1` | Log hits, misses, writes and state changes. |

The [installation guide](./docs/installation.md#environment-variables) has the full table. There
are no variables for timeouts or TTLs; for those, or your own client, see
[Custom handlers](./docs/custom-handlers.md).

`withCache(nextConfig, options?)` takes three options:

| Option | Default | What it does |
|---|---|---|
| `pages` | `true` | Also handle pages, route handlers and cached `fetch` (`cacheHandler`). `false` leaves them to Next. |
| `handlers` | built-in files | `{ page?, default?, remote? }`: paths to [your own handler files](./docs/custom-handlers.md). |
| `memory` | `{ heapPercent: 10 }` | The in-process cache budget. Not seen by a standalone `server.js`: use the `CACHE_MEMORY_*` variables there. See [Memory](./docs/operations.md#memory). |

`withCache` throws if the config already sets `cacheHandlers`, or `cacheHandler` unless
`pages: false`. Use `handlers` instead. The [API reference](./docs/api-reference.md#withcachenextconfig-options)
has the details.

## Requirements and testing

Redis 6.2+ or any Valkey, with Lua scripting allowed (revalidations use `ZADD GT` and a
single-key script). CI runs Redis 7 and Valkey 8, a production-build e2e matrix (memory, Redis,
Valkey, ElastiCache with TLS and an auth token) and an outage suite. Every PR that changes the
package also runs Next.js's own caching e2e suites, with two instances sharing Redis, and fails
on any regression against plain `next start`. ElastiCache IAM is tested by hand against a real
ElastiCache Serverless cache before each release.
[How it's tested](./docs/development.md#how-its-tested) has the details and known limits.

## Documentation

- [Installation & Setup](./docs/installation.md)
- [Usage Examples](./docs/usage.md)
- [How it works](./docs/how-it-works.md): tag coordination, pages and route handlers, Redis outages
- [Operations](./docs/operations.md): flushing, closing, logging
- [Custom handlers](./docs/custom-handlers.md): your own client and `CacheOptions`
- [Redis Configuration](./docs/redis.md): connections, key layout, sizing
- [API Reference](./docs/api-reference.md): every export, including the deprecated ones
- [Migrating](./docs/migrating.md)
- [Changelog](./CHANGELOG.md) and [releases](https://github.com/mrjasonroy/cache-components-cache-handler/releases)

## Development and contributing

```bash
git clone https://github.com/mrjasonroy/cache-components-cache-handler
cd cache-components-cache-handler
pnpm install
pnpm build
pnpm test
```

See [docs/development.md](./docs/development.md) for the test lanes and release process. AI agents
start with [CLAUDE.md](./CLAUDE.md); humans with [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT © [Jason Roy](https://github.com/mrjasonroy)
