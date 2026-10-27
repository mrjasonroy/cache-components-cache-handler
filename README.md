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

```bash
npm install --save-exact @mrjasonroy/cache-components-cache-handler
```

The package version follows Next.js. Pin it to the exact release for your Next.js version
(`--save-exact`; Next 16.4.3 → `16.4.3`) and upgrade the two together. A range such as `^16.4.3`
also accepts the 16.5 releases, which follow Next.js 16.5 and remove the APIs deprecated in
16.4.3.

```js
// next.config.mjs
import { withCache } from "@mrjasonroy/cache-components-cache-handler";

export default withCache({ cacheComponents: true });
```

```bash
REDIS_URL=redis://cache:6379   # unset → everything stays in memory (dev, CI, previews)
```

That's it. You keep writing `"use cache"`, `cacheTag` and `revalidateTag` as Next documents them
([examples](./docs/usage.md)). `ioredis` is installed automatically as an optional dependency
([unless optionals are skipped](./docs/installation.md#install)).

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

[How it works](./docs/how-it-works.md) has the details: what goes where, tag coordination, page
lifetimes and the outage table.

## Configuration

### `withCache(nextConfig, options?)`

These options are read when `next.config` loads. Runtime settings come from the environment, except `memory`.

| Option | Default | What it does |
|---|---|---|
| `pages` | `true` | Set `cacheHandler` (pages, route handlers, cached `fetch`) and `cacheMaxMemorySize: 0`. A `cacheMaxMemorySize` you set yourself is kept, with a warning if it is not `0`. `false` leaves `cacheHandler` and `cacheMaxMemorySize` as your config has them. |
| `handlers` | built-in files | `{ page?, default?, remote? }`: paths to [your own handler files](./docs/custom-handlers.md). |
| `memory` | `{ heapPercent: 10 }` | The in-process cache budget per runtime: `heapPercent` of V8's heap limit (a little above `--max-old-space-size`), or `maxMiB` (an absolute budget, which wins). Wins over the `CACHE_MEMORY_*` variables. Not seen by a standalone `server.js`, which never loads `next.config`: use the variables there. See [Memory](./docs/operations.md#memory). |

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
| `ELASTICACHE_IAM_USER` | unset | ElastiCache IAM authentication as this user id, instead of an auth token, with tokens refreshed by the package ([details](./docs/redis.md#iam-authentication)). Needs TLS. |
| `ELASTICACHE_CACHE_NAME` | — | With IAM: the replication group id or serverless cache name the token is signed for. Required. |
| `ELASTICACHE_REGION` | `AWS_REGION`, then `AWS_DEFAULT_REGION` | With IAM: the cache's region. |
| `ELASTICACHE_SERVERLESS` | from the hostname | With IAM: `true` for ElastiCache Serverless; unset, on for a `.serverless.` endpoint. |
| `CACHE_KEY_PREFIX` | `nextjs:` | Prefix for every key. Use it to share one Redis between apps. |
| `CACHE_REDIS` | `on` | `off` forces memory everywhere, even with a URL set. |
| `CACHE_DEBUG` | unset | `1` logs hits, misses, writes and state changes. It never logs the URL. |
| `CACHE_COMPRESSION` | `on` | Entries of 16 KB and more are Brotli-compressed. `off` stores them uncompressed. |
| `CACHE_MEMORY_HEAP_PERCENT` | `10` | In-process cache budget as a share of the V8 heap limit, in percent (more than 0, less than 100). |
| `CACHE_MEMORY_MAX_MIB` | unset | In-process cache budget in MiB. Wins over `CACHE_MEMORY_HEAP_PERCENT`. `withCache`'s `memory` wins over both. |

There are no tuning variables for timeouts or TTLs. The [installation guide](./docs/installation.md#environment-variables)
has the full table; for your own client or timeouts, see [Custom handlers](./docs/custom-handlers.md).

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
([results](./tests/next-deploy/results/baseline-v16.4.2.md); live results on the
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

ElastiCache IAM authentication is tested against a real ElastiCache Serverless cache (Valkey 8.1):
connecting with a token, re-authenticating the live connection, reconnecting, a tag revalidation
across two connections and `flushCache`. That needs an AWS account and a runner in the cache's
VPC, so it is not in per-PR CI: it is a manual gate before a release
(`scripts/aws-iam-e2e/run.sh`, see [development](./docs/development.md#elasticache-iam-against-a-real-cache)).
The token signing and refresh are unit-tested on every PR.
See [the harness README](./tests/next-deploy/README.md) and
[how it's tested](./docs/development.md#how-its-tested).

## Supported backends

| Backend | How |
|---|---|
| **Memory** | No `REDIS_URL`: dev, CI, previews, single instance |
| **Redis 6.2+** | `REDIS_URL=redis://…` or `rediss://…` |
| **Valkey** | `VALKEY_URL` or `REDIS_URL`, same URL format |
| **AWS ElastiCache** | `ELASTICACHE_ENDPOINT` + `ELASTICACHE_AUTH_TOKEN`, TLS on (`ELASTICACHE_TLS=false` turns it off) |
| **AWS ElastiCache, IAM auth** | `ELASTICACHE_ENDPOINT` (or a `rediss://` `REDIS_URL`) + `ELASTICACHE_IAM_USER`, `ELASTICACHE_CACHE_NAME`, `ELASTICACHE_REGION`. TLS required; Valkey 7.2+ or Redis OSS 7.0+; node-based or serverless (detected from a `.serverless.` endpoint, or `ELASTICACHE_SERVERLESS`). Needs the optional peer dependencies `@smithy/signature-v4`, `@aws-crypto/sha256-js` and `@aws-sdk/credential-provider-node`. [Details](./docs/redis.md#iam-authentication) |
| **Redis Cluster, Sentinel** | Your own ioredis client through a [custom handler](./docs/custom-handlers.md). `flushCache` scans every master. |

The minimum is Redis 6.2 (or any Valkey): revalidations use `ZADD GT` and a single-key Lua
script, so the server must allow `EVAL`/`EVALSHA`. CI runs Redis 7 and Valkey 8.
[Redis Configuration](./docs/redis.md) covers connections, key layout and sizing.

## Migrating

From 16.4.2, replace your handler files and `cacheHandlers` config with
`withCache({ cacheComponents: true })` and delete the files. `"use cache"` then goes to memory and
`"use cache: remote"` to Redis (use `"use cache: remote"` for anything that must be shared), and
pages go through Redis too. The cache starts cold, and
revalidations do not cross between 16.4.2 and 16.4.3 instances during a rolling deploy: deploy
with recreate, or revalidate once afterwards. `RedisCacheHandler` subclasses keep working.

From `@fortedigital/nextjs-cache-handler` or `@neshca/cache-handler`, replace `cacheHandler` and
`cacheMaxMemorySize` with `withCache`.

The [migration guide](./docs/migrating.md) has the details.

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
