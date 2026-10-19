# Redis Configuration

`withCache` connects to Redis from the environment and needs `ioredis` installed:

```bash
npm install ioredis
```

Most deployments only set `REDIS_URL`. This page covers the other connection forms, running
Redis, and what operators see in it.

## Connection from the environment

| Variable | Meaning |
|---|---|
| `REDIS_URL` / `VALKEY_URL` | `redis://` or `rediss://` (TLS) URL. Takes precedence over the ElastiCache form. |
| `REDIS_PASSWORD` | Password when the URL has none. |
| `ELASTICACHE_ENDPOINT`, `ELASTICACHE_PORT`, `ELASTICACHE_AUTH_TOKEN`, `ELASTICACHE_TLS` | Host form. Port `6379`, TLS on unless `ELASTICACHE_TLS=false`. |

URL examples:

```bash
REDIS_URL=redis://localhost:6379
REDIS_URL=redis://:password@cache.internal:6379/0
REDIS_URL=rediss://default:password@cache.example.com:6380   # TLS
```

The package opens one connection per process and shares it between every handler. It reconnects
forever, with backoff capped at 5 s. A command times out after 1 s, and a connection that times
out 3 times in a row is dropped and redialled. What the app does meanwhile is in the README under
[When Redis goes down](../README.md#when-redis-goes-down).

## Valkey

Valkey speaks the Redis protocol. Point `REDIS_URL` or `VALKEY_URL` at it; nothing else changes.
CI runs the outage suite and the e2e suite on Valkey 8 as well as Redis 7.

```bash
VALKEY_URL=redis://valkey.internal:6379
```

## AWS ElastiCache

ElastiCache usually gives you a hostname and an auth token instead of a URL:

```bash
ELASTICACHE_ENDPOINT=master.my-cache.abc123.use1.cache.amazonaws.com
ELASTICACHE_AUTH_TOKEN=...
```

That covers cluster-mode-disabled ElastiCache (one primary with replicas). Use the primary
endpoint, not a reader endpoint. For cluster-mode-enabled ElastiCache, use a `Cluster` client as
shown below.

## Your own client

For Sentinel, Cluster, IAM auth or other ioredis options, build the client yourself and pass it to
[custom handler files](../README.md#custom-handlers). Give all three handlers the same client so
they share one connection and one tag store.

A client you pass in is yours: the package never closes, disconnects or reconfigures it. Its own
commands reach the client through a proxy bounded by `commandTimeout`; after 3 timeouts in a row
the handlers serve from memory for 2 s at a time, until a command succeeds again. Your other uses
of the client are unaffected, so set the timeouts and retry strategy on the client too:

```js
// cache/redis.mjs
import Redis from "ioredis";

const key = Symbol.for("my-app.redis");
globalThis[key] ??= new Redis(process.env.REDIS_URL, {
  commandTimeout: 1000,
  maxRetriesPerRequest: 1,
  retryStrategy: (times) => Math.min(times * 200, 5000),
});
export const client = globalThis[key];
```

Parking the client on `globalThis` keeps it to one connection when Next loads the handler modules
separately.

### Redis Sentinel

```js
globalThis[key] ??= new Redis({
  sentinels: [
    { host: "sentinel-1", port: 26379 },
    { host: "sentinel-2", port: 26379 },
    { host: "sentinel-3", port: 26379 },
  ],
  name: "mymaster",
  commandTimeout: 1000,
});
```

### Redis Cluster

```js
import { Cluster } from "ioredis";

globalThis[key] ??= new Cluster(
  [
    { host: "node1", port: 6379 },
    { host: "node2", port: 6379 },
    { host: "node3", port: 6379 },
  ],
  { redisOptions: { commandTimeout: 1000 } },
);
```

Cluster mode needs no hash tags. Every command the handlers send touches a single key, so none
can fail with `CROSSSLOT`. `flushCache` scans every master. The two tag keys live on one shard
(see [Sizing](../README.md#sizing) for the hot-key cost).

## Running Redis locally

```bash
docker run -d -p 6379:6379 redis:7-alpine
```

In this repo, `pnpm docker:up` starts Redis on 6379, Valkey on 6380 and Redis Commander on 8081.

## What's in Redis

```
<prefix><buildId>:page:<key>   page, route handler or cached fetch entry
<prefix><buildId>:data:<key>   "use cache: remote" entry
<prefix>tags                   hash of every tag record: field = tag, value = "<stale>,<expired>" in ms
<prefix>tag-index              sorted set of the same tags, scored by last update (ms)
```

`<prefix>` is `CACHE_KEY_PREFIX` (`nextjs:` by default). Every key has a TTL, so Redis can run with
`maxmemory-policy volatile-lru` or `allkeys-lru`. Entries are binary and not human-readable.
`CACHE_DEBUG=1` on the app logs what is read and written.

```bash
redis-cli info memory
redis-cli --scan --pattern 'nextjs:*:page:*' | wc -l   # page entries, every build
redis-cli hlen nextjs:tags                            # tag records
redis-cli zrevrange nextjs:tag-index 0 9 withscores    # the 10 most recently invalidated tags
redis-cli hget nextjs:tags <tag>                       # one tag's "<stale>,<expired>"
```

The tag keys are shared by every build and refreshed to a 366-day TTL on every update; tags
untouched for 366 days are pruned from both. In `INFO commandstats`, expect about one `HMGET` per
page `GET`: every page read also reads the records of the tags that apply to it. See
[Sizing](../README.md#sizing).

Old builds' entries are not deleted on deploy; they expire on their own. To clear them sooner, use
[`flushCache`](../README.md#flushing-the-cache).

## Managed Redis services

Any service that speaks the Redis protocol over TCP works with a `rediss://` URL, including
Upstash's Redis endpoint (not its REST API). Services that only offer an HTTP API do not.

## The 16.5 data handler

`createRedisDataCacheHandler` (the handler behind `createCacheHandler`) takes a node-redis-style
client. Pass node-redis directly, or wrap ioredis with `createIoredisAdapter`. See the
[API reference](./api-reference.md#165-data-cache-api).
