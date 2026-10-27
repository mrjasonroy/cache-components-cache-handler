# Redis Configuration

`withCache` connects to Redis from the environment through `ioredis`, an optional dependency
installed with the package ([unless your package manager skips optionals](./installation.md#install)).

Most deployments only set `REDIS_URL`. This page covers the other connection forms, running
Redis, and what operators see in it.

## Connection from the environment

| Variable | Meaning |
|---|---|
| `REDIS_URL` / `VALKEY_URL` | `redis://` or `rediss://` (TLS) URL. Takes precedence over the ElastiCache form. |
| `REDIS_PASSWORD` | Password when the URL has none. |
| `ELASTICACHE_ENDPOINT`, `ELASTICACHE_PORT`, `ELASTICACHE_AUTH_TOKEN`, `ELASTICACHE_TLS` | Host form. Port `6379`, TLS on unless `ELASTICACHE_TLS=false`. |
| `ELASTICACHE_IAM_USER`, `ELASTICACHE_CACHE_NAME`, `ELASTICACHE_REGION`, `ELASTICACHE_SERVERLESS` | IAM authentication instead of an auth token. See [IAM authentication](#iam-authentication). |
| `CACHE_REDIS` | `off` (or `0`, `false`, `no`) forces memory everywhere, even with a URL set. |

URL examples:

```bash
REDIS_URL=redis://localhost:6379
REDIS_URL=redis://:password@cache.internal:6379/0
REDIS_URL=rediss://default:password@cache.example.com:6380   # TLS
```

The package opens one connection per process and shares it between every handler. It reconnects
forever, with backoff capped at 5 s. A command times out after 1 s, and a connection that times
out 3 times in a row is dropped and redialled. What the app does meanwhile is under
[When Redis goes down](./how-it-works.md#when-redis-goes-down).

## Valkey

Valkey speaks the Redis protocol. Point `REDIS_URL` or `VALKEY_URL` at it; nothing else changes.
CI runs the outage suite and the e2e suite on Valkey 8 as well as Redis 7.

Any server needs Redis 6.2 commands and Lua scripting: a revalidation is one single-key `EVALSHA`
(with `EVAL` the first time) and one `ZADD GT`.

```bash
VALKEY_URL=redis://valkey.internal:6379
```

## AWS ElastiCache

ElastiCache usually gives you a hostname and an auth token instead of a URL:

```bash
ELASTICACHE_ENDPOINT=master.my-cache.abc123.use1.cache.amazonaws.com
ELASTICACHE_AUTH_TOKEN=...
```

What to do depends on the kind of cache:

| Cache | Auth token | IAM |
|---|---|---|
| Serverless | The environment above. | [The environment](#iam-from-the-environment). |
| Cluster mode disabled (one primary, with replicas) | The environment above, with the primary endpoint (not a reader endpoint). | [The environment](#iam-from-the-environment). |
| Cluster mode enabled | [Your own `Cluster`](#redis-cluster). | [Your own `Cluster`](#iam-on-your-own-client) with `attachElastiCacheIamAuth`. |

ElastiCache Serverless needs no `Cluster`, but it is sharded behind its endpoint, so a command
over keys in different slots is refused with `CROSSSLOT`. The handlers only send single-key
commands. `flushCache` falls back to one `UNLINK` per key, pipelined, when its batched `UNLINK`
is refused. The background tag pruning (a two-key script) is skipped with a warning, so tag
records are bounded by field TTLs where the server has them, and otherwise grow until a flush,
as on a Cluster.

### IAM authentication

ElastiCache can authenticate with short-lived AWS IAM tokens instead of an auth token. The
package signs the tokens and keeps them fresh. First install the AWS signing packages. They are
optional peer dependencies, loaded only when IAM is on:

```bash
npm install @smithy/signature-v4 @aws-crypto/sha256-js @aws-sdk/credential-provider-node
```

Then pick your path:

| Your setup | Do this |
|---|---|
| Serverless or cluster-mode-disabled cache, built-in handlers (`withCache` alone) | [Set the environment](#iam-from-the-environment). No code. |
| The same caches, with the settings in code ([custom handler files](./custom-handlers.md)) or your own credentials provider | [Pass `iam`](#iam-in-a-custom-handler-file) to every handler. |
| Cluster-mode-enabled cache, or any client you build yourself | [Call `attachElastiCacheIamAuth`](#iam-on-your-own-client) on the client, then pass it as `client`. |

On every path:

- Settings you leave out come from the environment variables below.
- A client you pass in is never authenticated for you. `ELASTICACHE_IAM_USER` does not apply to
  it, and the `iam` option together with `client` throws.
- IAM that cannot work throws at startup: TLS off (`ELASTICACHE_TLS=false`, a `redis://` URL),
  no user, no cache name, no region, or the AWS packages missing. The handlers throw when Next
  loads them, `attachElastiCacheIamAuth` when you call it. The handlers skip Redis during
  `next build`, so on the first two paths the build needs none of this.
- AWS credentials come from the AWS SDK's default chain (environment variables, SSO, web
  identity, ECS and EKS pod identity, EC2 instance metadata), unless you pass `credentials`.

#### IAM from the environment

```bash
ELASTICACHE_ENDPOINT=master.my-cache.abc123.use1.cache.amazonaws.com
ELASTICACHE_IAM_USER=app-user
ELASTICACHE_CACHE_NAME=my-cache
ELASTICACHE_REGION=us-east-1
```

| Variable | Meaning |
|---|---|
| `ELASTICACHE_IAM_USER` | Turns IAM on. The ElastiCache user id, which ElastiCache requires to equal the user name. |
| `ELASTICACHE_CACHE_NAME` | The replication group id (node-based cache) or serverless cache name the token is signed for. Required: it is not parsed from the endpoint. Lowercased, as ElastiCache stores it. |
| `ELASTICACHE_REGION` | The cache's region. Falls back to `AWS_REGION`, then `AWS_DEFAULT_REGION`. Required. |
| `ELASTICACHE_SERVERLESS` | `true` for ElastiCache Serverless. Unset: on when the endpoint's hostname contains `.serverless.`. |

A `rediss://` URL in `REDIS_URL` works in place of `ELASTICACHE_ENDPOINT`. The token replaces
any password in the URL, and `ELASTICACHE_AUTH_TOKEN` is ignored.

#### IAM in a custom handler file

The `iam` option takes the same settings in code: `{ userId, cacheName, region, serverless,
credentials }`. `credentials` is an AWS credentials provider, such as the AWS SDK's
`fromTemporaryCredentials()`. The connection still comes from `url` or the environment. Give
every handler file the same `iam`, from one module:

```js
// cache/options.mjs
export const cacheOptions = {
  iam: { userId: "app-user", cacheName: "my-cache", region: "us-east-1" },
};
```

```js
// cache/remote.mjs (and the same in cache/page.mjs and cache/default.mjs)
import { createRemoteCacheHandler } from "@mrjasonroy/cache-components-cache-handler";
import { cacheOptions } from "./options.mjs";

export default createRemoteCacheHandler(cacheOptions);
```

#### IAM on your own client

Create the client with `lazyConnect: true` and TLS, and call `attachElastiCacheIamAuth` on it
once. Do not call `connect()`: the client connects once the first token is ready. This is the
only way to use IAM with cluster-mode-enabled ElastiCache:

```js
// cache/redis.mjs
import { Cluster } from "ioredis";
import { attachElastiCacheIamAuth } from "@mrjasonroy/cache-components-cache-handler";

function createClient() {
  const client = new Cluster(
    [{ host: "clustercfg.my-cache.abc123.use1.cache.amazonaws.com", port: 6379 }],
    {
      lazyConnect: true,
      dnsLookup: (address, callback) => callback(null, address), // keep hostnames for TLS
      redisOptions: { tls: {}, commandTimeout: 1000 },
    },
  );
  attachElastiCacheIamAuth(client, { userId: "app-user", cacheName: "my-cache", region: "us-east-1" });
  return client;
}

// One client per process: Next can load each handler file in its own module graph.
export const client = (globalThis.myAppRedis ??= createClient());
```

Then pass `client` to every handler, as in [Custom handlers](./custom-handlers.md). The same
works for a plain `Redis` client. `attachElastiCacheIamAuth` returns `{ refresh(), stop() }`;
`stop()` ends the refresh and leaves the client connected.

#### What the package does with the tokens

A token is valid for 15 minutes, and ElastiCache closes an IAM connection after 12 hours unless
it re-authenticates. So a token passed once as a password stops working on the first reconnect
after 15 minutes, and the app then serves from memory. Instead, on every path above:

- The first connection waits for the first token. Meanwhile the handlers serve from memory, as
  during an outage. On a connection the package opens, the handlers wait at most 500 ms for it
  and `flushCache` up to 5 s, so a one-off script on a cold pod does not give up before the
  token is signed.
- A new token is made every 10 minutes. It is kept for reconnects and sent as `AUTH` on every
  live connection (every node of a `Cluster`), which restarts the 12-hour limit.
- A reconnect whose token is more than 10 minutes old (after a suspended process, say) makes a
  new one first.
- A token that cannot be made (no credentials, a wrong region, or more than 10 s to sign) and a
  refused `AUTH` (`WRONGPASS`, `NOAUTH`, `NOPERM`) are logged as errors naming IAM, at most once
  a minute. The package tries again on the next reconnect or refresh. A cache call never fails
  because of it.
- The token is never logged. ioredis's own debug output (`DEBUG=ioredis:*`) does log each
  command's arguments, `AUTH` included, so don't turn it on in production with IAM.

#### On the AWS side

See [Authenticating with IAM](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/auth-iam.html).

- Valkey 7.2+ or Redis OSS 7.0+, with in-transit encryption (TLS) on.
- An ElastiCache user with IAM authentication, whose user id and user name are the same, in a
  user group attached to the cache:

  ```bash
  aws elasticache create-user --user-id app-user --user-name app-user \
    --engine redis --authentication-mode Type=iam --access-string "on ~* +@all"
  aws elasticache create-user-group --user-group-id app-users \
    --engine redis --user-ids default app-user
  aws elasticache modify-replication-group --replication-group-id my-cache \
    --user-group-ids-to-add app-users --apply-immediately
  # serverless: aws elasticache modify-serverless-cache --serverless-cache-name my-cache --user-group-id app-users
  ```

  On a cache shared with other apps, limit the key pattern to the key prefix
  (`on ~nextjs:* +@all`). Keep scripting and `INFO` allowed: revalidations run a Lua script, and
  ioredis checks readiness with `INFO`.
- An IAM policy on the app's role that allows `elasticache:Connect` on **both** the cache and the
  user:

  ```json
  {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": "elasticache:Connect",
        "Resource": [
          "arn:aws:elasticache:us-east-1:123456789012:replicationgroup:my-cache",
          "arn:aws:elasticache:us-east-1:123456789012:user:app-user"
        ]
      }
    ]
  }
  ```

  For a serverless cache the first resource is
  `arn:aws:elasticache:us-east-1:123456789012:serverlesscache:my-cache`.

A refused token is nearly always one of these: the user is not in the cache's user group, the
policy is missing one of the two resources, or the cache name, region or serverless setting does
not match the cache (the token is signed for them).

## Your own client

For Sentinel, Cluster or other ioredis options, build the client yourself and pass it to
[custom handler files](./custom-handlers.md). Give all three handlers the same client, so they
share one connection and one tag store. Create it once per process and keep it on `globalThis`:
Next can load each handler file in its own module graph, and a module-level client would then
open one connection per file.

```js
// cache/redis.mjs
import Redis from "ioredis";

function createClient() {
  return new Redis(process.env.REDIS_URL, {
    commandTimeout: 1000,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });
}

// One client per process: Next can load each handler file in its own module graph.
export const client = (globalThis.myAppRedis ??= createClient());
```

A client you pass in is yours: the package never closes, disconnects or reconfigures it. The
package's own commands on it are bounded by `commandTimeout`. After 3 timeouts in a row the
handlers serve from memory for 2 s at a time, until a command succeeds again. Your other uses of
the client are unaffected, so set the timeouts and retry strategy on the client too, as above.

### Redis Sentinel

The same `cache/redis.mjs`, with this `createClient`:

```js
function createClient() {
  return new Redis({
    sentinels: [
      { host: "sentinel-1", port: 26379 },
      { host: "sentinel-2", port: 26379 },
      { host: "sentinel-3", port: 26379 },
    ],
    name: "mymaster",
    commandTimeout: 1000,
  });
}
```

### Redis Cluster

The same `cache/redis.mjs`, importing `Cluster` from `ioredis`, with this `createClient`:

```js
function createClient() {
  return new Cluster(
    [
      { host: "node1", port: 6379 },
      { host: "node2", port: 6379 },
      { host: "node3", port: 6379 },
    ],
    { redisOptions: { commandTimeout: 1000 } },
  );
}
```

For cluster-mode-enabled ElastiCache with IAM, see
[IAM on your own client](#iam-on-your-own-client).

Cluster mode needs no hash tags. Every command the handlers send touches a single key, so none
can fail with `CROSSSLOT`. `flushCache` scans every master. The two tag keys live on one shard
(see [Sizing](#sizing) for the hot-key cost).

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

`<prefix>` is `CACHE_KEY_PREFIX` (`nextjs:` by default). `<buildId>` is the app's `BUILD_ID`, or
its deployment ID when one is set, percent-encoded
([why](./how-it-works.md#skew-protection-and-the-deployment-id)). It is read from the build
output that `next start` and a standalone `server.js` use, and it is `development` under
`next dev`. Every entry key has a TTL. A remote entry is kept until its
`expire`, or for `defaultTTL` (24 hours) when `expire` is infinite, at most 365 days; page entries
as described under [Pages and route handlers](./how-it-works.md#pages-and-route-handlers). The two
tag keys are shared by every build and have no key TTL. Individual fields and index members follow
the [tag retention rules](./how-it-works.md#distributed-tag-coordination-for-use-cache); flush
barriers stay until a full flush. Run Redis with `maxmemory-policy noeviction` or a `volatile-*`
policy (`volatile-lru`), never `allkeys-*` (such as `allkeys-lru`): an evicted tag hash brings
every invalidated entry back. Entries are binary and not human-readable.

The deprecated `createCacheHandler` keeps its 16.4.2 layout: `nextjs:data-cache:<key>` and
`nextjs:tags:<tag>`.

`CACHE_DEBUG=1` (or `true`) on the app logs what is read and written, with each value's size: `bytes` (the value; the uncompressed entry for pages) and, for pages and `"use cache: remote"`, `encodedBytes` (as stored in Redis).

### Entry format and compression

An entry is `NCH`, a format version byte and the value. Version 2 is a JSON header plus the raw
bytes of every Buffer in the value (no base64); bytes repeated within an entry, such as a page's
`/_full` segment, are stored once. Version 3 is a version 2 entry compressed with Brotli
(quality 4): `NCH` · `3` · a codec byte (`1` = Brotli; `2` is reserved for zstd) · the version 2
length (uint32, big-endian) · the compressed bytes.

Entries of 16 KB and more are written as version 3, unless compressing would not shrink them.
Entries over 64 MB are always written as version 2, and a version 3 entry stating a length over
64 MB is a miss, so a corrupt entry cannot make a read inflate hundreds of megabytes.
`CACHE_COMPRESSION=off` writes version 2 only. Readers read both versions whatever the setting,
and an entry they cannot read (16.4.2's JSON, a future version or codec, a corrupt or truncated
entry) is a miss.

For sizing, count on page entries taking 5 to 15 times less memory and bandwidth than their
uncompressed size; text-like `"use cache: remote"` values shrink as much. Measured on generated
listing pages: a ~200 KB page entry (140 KB as version 2) stores in about 14 KB, and a "5 MB"
search page (16 MB of HTML and RSC) in about 1 MB, which also keeps it well inside the 1 s
`commandTimeout` on a 100 Mbps link. Compression runs off the event loop and costs about 0.5 ms
per 200 KB written and 0.1 ms read. Values that are already compressed (images, archives) stay
version 2.

```bash
redis-cli info memory
redis-cli --scan --pattern 'nextjs:*:page:*' | wc -l   # page entries, every build
redis-cli hlen nextjs:tags                            # tag records
redis-cli zrevrange nextjs:tag-index 0 9 withscores    # the 10 most recently invalidated tags
redis-cli hget nextjs:tags <tag>                       # one tag's "<stale>,<expired>"
```

The two tag keys have no key TTL. Their fields and index members are expired or pruned by the
[tag retention rules](./how-it-works.md#distributed-tag-coordination-for-use-cache); on a Cluster
without hash-field TTLs they grow until `flushCache({ scope: "all" })`.

In `INFO commandstats`, expect about one `HMGET` per page `GET`: every page read also reads the
records of the tags that apply to it. See [Sizing](#sizing).

Old builds' entries are not deleted on deploy; they expire on their own. To clear them sooner, use
[`flushCache`](./operations.md#flushing-the-cache).

## Sizing

Redis command volume, not latency, is what grows with traffic:

| Operation | Redis commands |
|---|---|
| Page, route handler or cached `fetch` read | 1 `GET` + 1 `HMGET` of every tag that applies (soft tags, `fetch` tags, the entry's tags), in one round trip. The first read of an entry by a process that did not write it is 3 commands in 2 round trips. |
| `"use cache: remote"` read | 1 `GET` + 1 `HMGET` of the entry's tags and the soft tags, in one round trip (2 round trips the first time a process reads an entry it did not write). |
| `"use cache"` (memory) read | none. One tag sync per request, at most every 100 ms: 1 `ZRANGEBYSCORE` of the index since the last sync, plus 1 `HMGET` of the tags that changed, if any. |
| `revalidateTag`, `updateTag`, `revalidatePath` | 1 `EVALSHA` (one single-key script) + 1 `ZADD GT`, however many tags. The first one on a server that has not seen the script adds 1 `EVAL`. |

The tag read shares the entry's round trip, so page latency is unchanged; size Redis for the
command rate. Nothing runs `HGETALL`: an `HMGET` costs in proportion to the tags it reads, not to
the size of the hash. 100,000 tags take about 23 MB.

**Memory and network.** Entries of 16 KB and more are stored Brotli-compressed (quality 4, off the
event loop), usually 5 to 15 times smaller: a ~200 KB page entry takes about 14 KB in Redis. Size
Redis memory for the compressed entries; `CACHE_DEBUG` logs both sizes for page and remote entries
(`bytes`, `encodedBytes`).

**Hot key.** One shard serves the tag hash, on a Cluster too. At 2,000 page reads/s that is about
2% of one core; it starts to matter around 50,000 page reads/s, or with hundreds of tags per page.
Read replicas are the escape hatch if it ever does.

[DEC-3](../implementation/DECISIONS.md) in `implementation/DECISIONS.md` has the measurements.

## Managed Redis services

Any service that speaks the Redis protocol over TCP works with a `rediss://` URL, including
Upstash's Redis endpoint (not its REST API). Services that only offer an HTTP API do not.

## The legacy data handler

Deprecated in 16.4.3 and removed in 16.5: use `withCache`, or `createRemoteCacheHandler({ client })`
with an ioredis client. Until then, `createRedisDataCacheHandler` (the handler behind
`createCacheHandler`) takes a node-redis-style client: node-redis directly, or ioredis wrapped
with `createIoredisAdapter`. See the [API reference](./api-reference.md#legacy-data-cache-api).
