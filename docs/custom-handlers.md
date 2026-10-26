# Custom handlers

Use your own handler files when you need a client you built yourself (Sentinel, a custom Cluster)
or different timeouts. ElastiCache IAM authentication needs neither: the environment turns it on
(see [IAM authentication](./redis.md#iam-authentication)), and the `iam` option sets it in a
handler file. Write one file per handler and give the paths to `withCache`. Each file keeps its
directive's role: `page` for pages, route handlers and cached `fetch`, `remote` for
`"use cache: remote"` (Redis), `default` for `"use cache"` (per-instance memory, shared tag
invalidation):

```js
// cache/redis.mjs: one client for both files, parked on globalThis because Next can load the
// two handler modules separately
import Redis from "ioredis";

const key = Symbol.for("my-app.redis");
globalThis[key] ??= new Redis(process.env.REDIS_URL, { commandTimeout: 1000 });
export const client = globalThis[key];
```

```js
// cache/page.mjs
import { createPageCacheHandler } from "@mrjasonroy/cache-components-cache-handler";
import { client } from "./redis.mjs";

export default createPageCacheHandler({ client });
```

```js
// cache/remote.mjs
import { createRemoteCacheHandler } from "@mrjasonroy/cache-components-cache-handler";
import { client } from "./redis.mjs";

export default createRemoteCacheHandler({ client });
```

```js
// cache/default.mjs
import { createLocalCacheHandler } from "@mrjasonroy/cache-components-cache-handler";
import { client } from "./redis.mjs";

export default createLocalCacheHandler({ client });
```

```js
// next.config.mjs
import { withCache } from "@mrjasonroy/cache-components-cache-handler";

export default withCache(
  { cacheComponents: true },
  {
    handlers: {
      page: "./cache/page.mjs",
      remote: "./cache/remote.mjs",
      default: "./cache/default.mjs",
    },
  },
);
```

Relative `handlers` paths resolve against the working directory (`process.cwd()`, where `next`
runs), not against `next.config`; when the two can differ, pass an absolute path
(`fileURLToPath(new URL("./cache/page.mjs", import.meta.url))`).

Handlers that share a client and key prefix share one connection and one tag store. A handler
you don't replace keeps reading the environment. So if you pass a `client` and leave `REDIS_URL`
unset, also provide `default`; otherwise `"use cache"` tag invalidation stays local to each
instance.

A client you pass in is yours: the package never closes, disconnects or reconfigures it. The
package's own commands reach it through a proxy that bounds them by `commandTimeout`. After 3
timeouts in a row the handlers serve from memory for 2 s at a time, until a command succeeds
again. Your other uses of the client are unaffected, so set its own `commandTimeout` (and a
`retryStrategy`) for those. [Redis Configuration](./redis.md#your-own-client) has Sentinel and
Cluster clients.

For ElastiCache IAM authentication on a client of your own, which is the way to use IAM with
cluster-mode-enabled ElastiCache (a `Cluster`), create the client with `lazyConnect: true` and TLS,
do not connect it, and call `attachElastiCacheIamAuth(client, { userId, cacheName, region })`
once: it connects the client when the first token is ready, refreshes the token every 10 minutes
and re-authenticates the live connections. Fields you leave out come from the `ELASTICACHE_*`
environment. Then pass the client as `client` (not `iam`, which throws with `client`):

```js
// cache/redis.mjs
import { Cluster } from "ioredis";
import { attachElastiCacheIamAuth } from "@mrjasonroy/cache-components-cache-handler";

const key = Symbol.for("my-app.redis");
globalThis[key] ??= (() => {
  const client = new Cluster([{ host: process.env.ELASTICACHE_ENDPOINT, port: 6379 }], {
    lazyConnect: true,
    dnsLookup: (address, callback) => callback(null, address),
    redisOptions: { tls: {}, commandTimeout: 1000 },
  });
  attachElastiCacheIamAuth(client, { userId: "app-user", cacheName: "my-cache", region: "us-east-1" });
  return client;
})();
export const client = globalThis[key];
```

ElastiCache Serverless and cluster-mode-disabled caches need none of this: the environment's
connection handles them.

All commands share one connection, so a large value on a slow link delays the commands queued
behind it. At 1000 ms, a 5 MB entry needs about 40 Mbit/s (compression usually makes a page
entry much smaller than the page); on a slower link (cross-region, or an
ElastiCache node out of network burst credits) raise `commandTimeout`, or 3 timeouts in a row
send the handlers to memory.

## `CacheOptions`

All three factories take `CacheOptions`:

| Option | Default | Meaning |
|---|---|---|
| `url` | `REDIS_URL` / `VALKEY_URL` / the ElastiCache env; unset → memory only | Redis URL, password included. |
| `client` | — | Your own ioredis `Redis` or `Cluster`. Overrides `url`. |
| `keyPrefix` | `CACHE_KEY_PREFIX` / `nextjs:` | Prefix for every key. |
| `memoryFallback` | `true` | Serve from memory (each entry at most 60 s) while Redis is down. `false` → miss instead. |
| `commandTimeout` | `1000` | Per-command timeout in ms. Also bounds the package's commands on a `client` you pass in. |
| `connectTimeout` | `2000` (`10000` with the `ELASTICACHE_*` host form) | Ms to wait for a connection the package opens. Not used with `client`. |
| `socketTimeout` | `2000` | Ms a pending command may go without a reply before a connection the package opens is dropped and reopened. Not used with `client`. |
| `maxConsecutiveTimeouts` | `3` | Command timeouts in a row that drop a connection the package opens or, for a `client` you pass in, send the handlers to memory for 2 s at a time. |
| `iam` | IAM when `ELASTICACHE_IAM_USER` is set | ElastiCache IAM authentication for the connection the package opens: `{ userId, cacheName, region, serverless, credentials }`, each falling back to the environment (see [IAM authentication](./redis.md#iam-authentication)). Throws with `client`; for your own client call `attachElastiCacheIamAuth(client, iam)`. |
| `debug` | `CACHE_DEBUG` | Log hits, misses and state changes. |
| `logger` | `setCacheLogger`'s, else the console | Where this handler's warnings, errors and debug lines go (see [Logging](./operations.md#logging)). |

Handlers given the same connection settings share one connection and one tag state. Give every
handler file the same `url`, timeouts and `maxConsecutiveTimeouts`: different settings open a
second connection to the same server, and the package logs a warning when that happens.

`createPageCacheHandler` and `createRemoteCacheHandler` also take `buildId` (default: the app's
deployment ID when one is set, else its `BUILD_ID`; see
[skew protection](./how-it-works.md#skew-protection-and-the-deployment-id)), the build that
scopes entry keys. Both also take `defaultTTL`, in seconds:
`createPageCacheHandler` keeps an entry with neither `revalidate` nor `expire` that long (default
and maximum 365 days), and `createRemoteCacheHandler` keeps an entry whose `expire` is infinite
that long (default 24 hours, maximum 365 days; anything but a number greater than 0 throws).

`CACHE_REDIS=off` and the build phase apply to custom handlers too: they never use Redis then.

Every factory's full signature is in the [API reference](./api-reference.md).
