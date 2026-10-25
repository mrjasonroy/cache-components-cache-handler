# Operations

Flushing the cache, closing it in tests and scripts, how much memory it holds, and sending its
logs to your own logger.
What sits in Redis, and how to size it, is in [Redis Configuration](./redis.md#whats-in-redis).

## Flushing the cache

```ts
import { flushCache } from "@mrjasonroy/cache-components-cache-handler";

await flushCache();                  // this build's entries
await flushCache({ scope: "all" });  // every key under CACHE_KEY_PREFIX, tag records included
```

`flushCache` uses SCAN + UNLINK and scans every master of a Cluster. It returns `{ deleted }`, the
number of Redis keys deleted. It also empties **this process's** in-memory stores. Other
instances keep their in-memory `"use cache"` values until those reach `revalidate`, or until a
tag invalidation reaches them. Without Redis it only empties the memory stores and returns how
many entries they held. Either way it then records the flush like a tag revalidation (a field in
`<prefix>tags`), so prerendered build output older than the flush is not served again, even
after the tag records were deleted. If Redis is configured but unavailable, it throws and deletes
nothing. It also refuses `scope: "all"` when the key prefix is empty, which would delete the
whole database.

| Option | Default | Meaning |
|---|---|---|
| `scope` | `"build"` | `"build"` deletes `<prefix><buildId>:*`. `"all"` deletes every key under the prefix. |
| `buildId` | the app's deployment ID if set, else its `BUILD_ID` | The build that `scope: "build"` deletes. |
| `url`, `client`, `keyPrefix` | the environment | Which Redis and prefix, as in [`CacheOptions`](./custom-handlers.md#cacheoptions). |

The package ships no HTTP endpoint. The route is yours to write and to authenticate:

```ts
// app/api/admin/cache/flush/route.ts
import { flushCache } from "@mrjasonroy/cache-components-cache-handler";

export async function POST(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CACHE_FLUSH_TOKEN}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return Response.json(await flushCache());
}
```

`scope: "all"` matches by prefix, so it also deletes keys written under the same prefix by
`createCacheHandler` and by 16.4.2's `RedisCacheHandler`. With the default `nextjs:` prefix that
means everything under it, 16.4.2's `nextjs:cache:*`, `nextjs:tags:*` and `nextjs:data-cache:*`
included, and any other app's keys that share the `nextjs:` prefix. On a Cluster, a key caught
in a slot migration is retried through the Cluster client; if any still fail, `flushCache` logs a
warning and returns `{ deleted, partial: true, failed }` instead of throwing, so run it again.
A Redis node that stops answering (each Cluster master is bounded by `commandTimeout` too) or
refuses part-way makes `flushCache` throw; some keys may already be deleted, so run it again.

## Closing the cache

A Next server never needs this. A test run, script or CLI that used the handlers or `flushCache`
calls `closeCache()` at the end, so Node can exit instead of waiting on an open Redis connection:

```ts
// a Vitest `setupFiles` file or a Jest `setupFilesAfterEnv` file
import { afterAll } from "vitest"; // Jest: the global afterAll
import { closeCache } from "@mrjasonroy/cache-components-cache-handler";

afterAll(() => closeCache());
```

`closeCache()` closes every Redis connection the package opened in this process (one per
connection settings, shared by all handlers) and empties its in-memory stores. It first waits
for revalidations in flight and sends any Redis has not acknowledged one last time. A
revalidation Redis still refuses (it is down, or read-only during a failover) is not lost: this
process keeps applying it, and the handlers send it once Redis takes writes again, if you use
them after the close. `closeCache()` does not fail because Redis is down. It is safe to call more
than once, and concurrently: a call made while a close runs closes, after it, any connection a
cache call opened meanwhile. A `client` you passed in is never closed; close it yourself.
Handlers created before it keep working: on their next call they reconnect, all onto one new
connection. The deprecated `createCacheHandler` is the exception: it keeps its closed connection
and serves from memory, so create it again after `closeCache()`.

## Memory

Each Node process holds these in memory, on top of what Next itself uses:

| What | Cap | Fills when |
|---|---|---|
| `"use cache"` values (the local handler) | 32 MiB, 10,000 entries | Always |
| Tag lists of entries read or written | 2 MiB, 10,000 entries | With Redis |
| Page entries kept in memory | 16 MiB | Without Redis, or `MEMORY_ONLY_TAG` entries |
| `"use cache: remote"` entries kept in memory | 16 MiB | Without Redis, or `MEMORY_ONLY_TAG` entries |
| Page entries written during an outage | 16 MiB | Redis down; emptied on reconnect |
| `"use cache: remote"` entries written during an outage | 16 MiB | Redis down; emptied on reconnect |
| Tag records | about 150 bytes per tag | Always |

So 34 MiB at most while Redis is healthy (66 MiB if you use `MEMORY_ONLY_TAG`), 64 MiB without
Redis, and 98 MiB during an outage. An entry larger than its cap is not kept in memory. Sizes count values and keys, not
JavaScript object overhead, so heap use runs somewhat higher.

Tag records cover every tag revalidated in the last 365 days (longer for a revalidation with a
longer `expire`), the same set Redis keeps; older ones are dropped. With Redis, the first
`"use cache"` read after startup loads them all: 100,000 such tags take about 15 MiB.

Sizing a pod: measure your app's own baseline (the pod's memory after warm-up with the cache
empty) and leave room for it plus the cache's 100 MiB under the container limit. Set `--max-old-space-size` to about 75% of the
container limit, never above it, so V8 collects garbage before the kernel kills the process, for
example `NODE_OPTIONS=--max-old-space-size=448` for a 600 MB limit. A value above the limit lets
the heap grow until the container is killed for running out of memory.

## Logging

Warnings, errors and `CACHE_DEBUG` lines go to the console by default. To send them to your own
logger (anything with `error` and `warn` methods), set it once per process in `instrumentation.ts`:

```ts
// instrumentation.ts
import { setCacheLogger } from "@mrjasonroy/cache-components-cache-handler";
import { logger } from "./lib/logger";

export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") setCacheLogger(logger);
}
```

Each line is `logger.error(message, meta)`, `logger.warn(...)`, `logger.info?.(...)` or
`logger.debug?.(...)`. `message` is the line the console would have printed, and `meta` carries
its details (an `error`, the `operation`). A logger without `info` or `debug` drops those lines.
Errors stay rate-limited, as on the console. Lines written before `register()` runs (a
`withCache` warning while `next.config` loads) still go to the console.

winston and `console` take `(message, meta)` as they are. pino and bunyan take the fields first,
so pass an adapter, or `meta` is lost:

```ts
const log = (level: "error" | "warn" | "info" | "debug") =>
  (message: string, meta?: Record<string, unknown>) => logger[level](meta ?? {}, message);
setCacheLogger({ error: log("error"), warn: log("warn"), info: log("info"), debug: log("debug") });
```

In a [custom handler file](./custom-handlers.md), `createRemoteCacheHandler`,
`createLocalCacheHandler` and `createRedisCacheHandler` also take `logger`, which wins over
`setCacheLogger` for that handler. The Redis connection and tag state that handlers share log
through the logger of the handler that opened them, so give every handler the same one, or use
`setCacheLogger`.

The package never logs a Redis URL or the connection options, which can hold a password. What it
logs is scrubbed on the way out: an error (and each error in its `cause` chain) keeps only its
name, message, stack, `code`, `errno`, `syscall`, `address` and `port`, so the failed command
ioredis attaches to an error (a rejected `AUTH` carries the password it tried) is dropped; objects
lose `command`, `password` and similar keys; other values (a `Buffer`, a class instance) are logged
as a placeholder such as `[Buffer 12 bytes]`; and URLs in any text lose their user information.
Other free text in a message is not scrubbed: a credential an error message spells out some other
way reaches the log. A logger that throws never fails a cache call: the line goes to the console
instead, with one note that the logger threw.
