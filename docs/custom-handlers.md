# Custom handlers

Use your own handler files when you need a client you built yourself (Sentinel, a Cluster) or
different timeouts. ElastiCache IAM on a serverless or cluster-mode-disabled cache needs neither:
the environment turns it on ([IAM authentication](./redis.md#iam-authentication)).

Write one file per handler and give the paths to `withCache`. Each file keeps its directive's
role:

- `page`: pages, route handlers and cached `fetch`.
- `remote`: `"use cache: remote"` (Redis).
- `default`: `"use cache"` (per-instance memory, shared tag invalidation).

```js
// cache/redis.mjs
import Redis from "ioredis";

function createClient() {
  return new Redis(process.env.REDIS_URL, { commandTimeout: 1000 });
}

// One client per process: Next can load each handler file in its own module graph.
export const client = (globalThis.myAppRedis ??= createClient());
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
unset, replace all three: a handler you leave out runs without Redis. For `default`, that means
`"use cache"` tag invalidation stays local to each instance.

A client you pass in is yours: the package never closes, disconnects or reconfigures it. The
package's own commands on it are bounded by `commandTimeout`. After 3 timeouts in a row the
handlers serve from memory for 2 s at a time, until a command succeeds again. Your other uses of
the client are unaffected, so set its own `commandTimeout` and `retryStrategy` for those.
[Redis Configuration](./redis.md#your-own-client) has Sentinel and Cluster clients.

For ElastiCache IAM on a client of your own (the only way to use IAM with cluster-mode-enabled
ElastiCache), call `attachElastiCacheIamAuth` on it inside `createClient`. Do not pass `iam`
with `client`: that throws. [IAM on your own client](./redis.md#iam-on-your-own-client) has the
example.

All commands share one connection, so a large value on a slow link delays the commands queued
behind it. At 1000 ms, a 5 MB entry needs about 40 Mbit/s. Compression usually makes a page
entry much smaller than the page. On a slower link (cross-region, or an ElastiCache node out of
network burst credits) raise `commandTimeout`, or 3 timeouts in a row send the handlers to
memory.

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
handler file the same `url`, `iam`, timeouts and `maxConsecutiveTimeouts`: different settings
open a second connection to the same server, and the package logs a warning when that happens.

`createPageCacheHandler` and `createRemoteCacheHandler` also take:

- `buildId`: the build that scopes entry keys. Default: the app's deployment ID when one is set,
  else its `BUILD_ID` (see
  [skew protection](./how-it-works.md#skew-protection-and-the-deployment-id)).
- `defaultTTL`, in seconds. The page handler keeps an entry with neither `revalidate` nor
  `expire` that long (default and maximum 365 days). The remote handler keeps an entry whose
  `expire` is infinite that long (default 24 hours, maximum 365 days); anything but a finite
  number greater than 0 throws.

`CACHE_REDIS=off` and the build phase apply to custom handlers too: they never use Redis then.

Every factory's full signature is in the [API reference](./api-reference.md).
