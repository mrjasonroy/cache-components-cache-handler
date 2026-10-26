# Cache Components Cache Handler

One Redis-backed cache for a Next.js 16+ app, safe through a Redis outage: pages, route handlers
and `"use cache: remote"` shared across every instance, and `"use cache"` in each instance's
memory with revalidation shared across all of them.

[![npm version](https://badge.fury.io/js/@mrjasonroy%2Fcache-components-cache-handler.svg)](https://www.npmjs.com/package/@mrjasonroy/cache-components-cache-handler)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Next.js 16+](https://img.shields.io/badge/Next.js-16%2B-black)](https://nextjs.org/)
[![CI](https://github.com/mrjasonroy/cache-components-cache-handler/actions/workflows/ci.yml/badge.svg)](https://github.com/mrjasonroy/cache-components-cache-handler/actions/workflows/ci.yml)
[![Next.js deploy tests](https://github.com/mrjasonroy/cache-components-cache-handler/actions/workflows/next-deploy-tests.yml/badge.svg?event=pull_request)](https://github.com/mrjasonroy/cache-components-cache-handler/actions/workflows/next-deploy-tests.yml)

## Quick start

<!-- rc: drop "@rc" (and the note below) once 16.4.3 is the npm latest release -->
```bash
npm install @mrjasonroy/cache-components-cache-handler@rc
```

`withCache` is new in 16.4.3, currently a release candidate on the `rc` tag. Drop `@rc` once
16.4.3 is the latest release.

```js
// next.config.mjs
import { withCache } from "@mrjasonroy/cache-components-cache-handler";

export default withCache({ cacheComponents: true });
```

```bash
REDIS_URL=redis://cache:6379   # unset → everything stays in memory (dev, CI, previews)
```

That's it. You keep writing `"use cache"`, `cacheTag` and `revalidateTag` as Next documents them
([examples](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/usage.md)). `ioredis` is installed automatically as an optional dependency.

## What you get

- **Pages and route handlers** (and cached `fetch`) stored in Redis, shared by every instance.
  Prerendered pages are served from the build output after a restart.
- **Next's directives, one to one.** `"use cache: remote"` entries live in Redis, shared by every
  instance; plain `"use cache"` stays in each instance's memory, with tag invalidation shared
  through Redis. `"use cache: private"` is Next's own and never reaches a handler. There are no
  extra modes: pick the directive. Next's deprecated `experimental.useCache` flag works as well as
  `cacheComponents`.
- **Revalidation across instances.** `revalidateTag`, `updateTag` and `revalidatePath` reach
  every instance and every handler, including each instance's in-memory `"use cache"` values.
- **Redis outage safety.** A request never fails because of the cache. Commands time out after
  1 s, and while Redis is down the app serves from per-instance memory, then goes back to Redis.
- **Entries scoped by build**, so a deploy never serves the previous build's pages.
- **`next build` never connects to Redis.**

[How it works](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/how-it-works.md) has the details: what goes where, tag coordination, page
lifetimes and the outage table.

## Configuration

### `withCache(nextConfig, options?)`

These options are read when `next.config` loads. Runtime settings come from the environment.

| Option | Default | What it does |
|---|---|---|
| `pages` | `true` | Set `cacheHandler` (pages, route handlers, cached `fetch`) and `cacheMaxMemorySize: 0`. A `cacheMaxMemorySize` you set yourself is kept, with a warning if it is not `0`. `false` leaves `cacheHandler` and `cacheMaxMemorySize` as your config has them. |
| `handlers` | built-in files | `{ page?, default?, remote? }`: paths to [your own handler files](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/custom-handlers.md). |

```js
// "use cache" only; leave pages to Next's default cache
export default withCache({ cacheComponents: true }, { pages: false });
```

`withCache` throws if the config already sets `cacheHandlers`, or `cacheHandler` unless
`pages: false`, because two configs fighting over the cache is always a bug. Use `handlers`
instead. It also accepts a function-form `next.config`.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `REDIS_URL` (or `VALKEY_URL`) | unset → memory only | `redis://` or `rediss://` URL, password included. |
| `REDIS_PASSWORD` | — | Password when the URL has none. |
| `ELASTICACHE_ENDPOINT`, `ELASTICACHE_PORT`, `ELASTICACHE_AUTH_TOKEN`, `ELASTICACHE_TLS` | port `6379`, TLS on | Host form, used when no URL is set. `ELASTICACHE_TLS=false` turns TLS off. |
| `CACHE_KEY_PREFIX` | `nextjs:` | Prefix for every key. Use it to share one Redis between apps. |
| `CACHE_REDIS` | `on` | `off` forces memory everywhere, even with a URL set. |
| `CACHE_DEBUG` | unset | `1` logs hits, misses, writes and state changes. It never logs the URL. |
| `CACHE_COMPRESSION` | `on` | Entries of 16 KB and more are Brotli-compressed. `off` stores them uncompressed. |

There are no tuning variables for timeouts or TTLs. The [installation guide](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/installation.md#environment-variables)
has the full table; for your own client or timeouts, see [Custom handlers](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/custom-handlers.md).

## Tested against Next.js's own tests

Every PR that changes the package's source runs the caching e2e suites from the
[`vercel/next.js`](https://github.com/vercel/next.js) repo, using Next's deploy-mode test harness
for deployment adapters. Each suite runs twice: once against a plain `next start`, and once with
this package, two instances behind a round-robin proxy (one instance where a fixture keeps its own
handler), sharing one Redis. CI fails if a suite (or a test) that passes on `next start` does not
pass with the package.

At Next 16.4.2 that is **0 regressions outside one known Next bug**: apart from `app-static`
(below), every suite and test that passes on `next start` also passes with the package. 28
suites, 18 of which run tests in deploy mode
([results](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/tests/next-deploy/results/baseline-v16.4.2.md); live results on the
[deploy-tests workflow](https://github.com/mrjasonroy/cache-components-cache-handler/actions/workflows/next-deploy-tests.yml)).
The limits:

- `test/e2e/app-dir/app-static` fails with any custom cache handler, because of a Next bug
  (Turbopack's edge `cacheHandlers` registration, fixed in a later Next canary,
  vercel/next.js#100046). It is listed as a known failure.
- 10 suites, such as `use-cache` and `ppr-full`, run no tests in deploy mode, so they are not
  covered here.

The package's own tests add an e2e matrix on production builds (memory, Redis, Valkey, and the
ElastiCache host form: Redis with TLS and an auth token), including two instances sharing Redis
and Redis stopped mid-run, and an outage suite on real Redis 7 and Valkey 8 (down at boot, lost
mid-run, stalled, back).
See [the harness README](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/tests/next-deploy/README.md) and
[how it's tested](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/development.md#how-its-tested).

## Supported backends

| Backend | How |
|---|---|
| **Memory** | No `REDIS_URL`: dev, CI, previews, single instance |
| **Redis 6.2+** | `REDIS_URL=redis://…` or `rediss://…` |
| **Valkey** | `VALKEY_URL` or `REDIS_URL`, same URL format |
| **AWS ElastiCache** | `ELASTICACHE_ENDPOINT` + `ELASTICACHE_AUTH_TOKEN`, TLS on (`ELASTICACHE_TLS=false` turns it off) |
| **Redis Cluster, Sentinel** | Your own ioredis client through a [custom handler](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/custom-handlers.md). `flushCache` scans every master. |

The minimum is Redis 6.2 (or any Valkey): revalidations use `ZADD GT` and a single-key Lua
script, so the server must allow `EVAL`/`EVALSHA`. CI runs Redis 7 and Valkey 8.
[Redis Configuration](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/redis.md) covers connections, key layout and sizing.

## Migrating

From 16.4.2, replace your handler files and `cacheHandlers` config with
`withCache({ cacheComponents: true })` and delete the files. `"use cache"` then goes to memory and
`"use cache: remote"` to Redis (use `"use cache: remote"` for anything that must be shared), and
pages go through Redis too. The cache starts cold, and
revalidations do not cross between 16.4.2 and 16.4.3 instances during a rolling deploy: deploy
with recreate, or revalidate once afterwards. `RedisCacheHandler` subclasses keep working.

From `@fortedigital/nextjs-cache-handler` or `@neshca/cache-handler`, replace `cacheHandler` and
`cacheMaxMemorySize` with `withCache`.

The [migration guide](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/migrating.md) has the details.

## Documentation

- [Installation & Setup](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/installation.md)
- [Usage Examples](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/usage.md)
- [How it works](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/how-it-works.md): tag coordination, pages and route handlers, Redis outages
- [Operations](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/operations.md): flushing, closing, logging
- [Custom handlers](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/custom-handlers.md): your own client and `CacheOptions`
- [Redis Configuration](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/redis.md): connections, key layout, sizing
- [API Reference](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/api-reference.md): every export, including the deprecated ones
- [Migrating](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/migrating.md)
- [Changelog](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/CHANGELOG.md) and [releases](https://github.com/mrjasonroy/cache-components-cache-handler/releases)

## Development and contributing

```bash
git clone https://github.com/mrjasonroy/cache-components-cache-handler
cd cache-components-cache-handler
pnpm install
pnpm build
pnpm test
```

See [docs/development.md](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/development.md) for the test lanes and release process. AI agents
start with [CLAUDE.md](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/CLAUDE.md); humans with [CONTRIBUTING.md](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/CONTRIBUTING.md).

## License

MIT © [Jason Roy](https://github.com/mrjasonroy)
