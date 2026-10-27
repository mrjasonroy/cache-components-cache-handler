import type { RedisClient } from "./redis.js";

/**
 * Minimal structural type for an ioredis-compatible client.
 *
 * Only the methods the data cache handler relies on are declared, so consumers
 * don't need ioredis' types in scope to call {@link createIoredisAdapter}. Both
 * ioredis `Redis` and `Cluster` instances satisfy this shape.
 *
 * @deprecated Part of the 16.4.2 API; pass the ioredis client to `createRemoteCacheHandler({ client })`. Still works in 16.4.x; removed in 16.5.
 */
export interface IoredisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  ttl(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
}

/**
 * Wrap an ioredis client so it satisfies the node-redis-style {@link RedisClient}
 * contract expected by `createRedisDataCacheHandler`.
 *
 * The data cache handler issues node-redis-style SET options
 * (`set(key, value, { EX: seconds })`). ioredis instead expects positional
 * arguments (`set(key, value, "EX", seconds)`), so this adapter translates the
 * option object. Passing a raw ioredis client without this translation makes
 * Redis reject the SET with `ERR syntax error`, silently breaking TTLs and
 * caching.
 *
 * @example
 * ```typescript
 * import Redis from "ioredis";
 * import {
 *   createIoredisAdapter,
 *   createRedisDataCacheHandler,
 * } from "@mrjasonroy/cache-components-cache-handler";
 *
 * const client = new Redis(process.env.REDIS_URL);
 *
 * export default createRedisDataCacheHandler({
 *   redis: createIoredisAdapter(client),
 * });
 * ```
 *
 * @deprecated Only needed by the deprecated `createRedisDataCacheHandler`. Pass an ioredis client
 *   straight to `createRemoteCacheHandler({ client })` instead.
 *   It keeps working in 16.4.x, logs a one-time deprecation warning, and is removed in 16.5.
 */
export function createIoredisAdapter(redis: IoredisLike): RedisClient {
  return {
    get: (key) => redis.get(key),
    set: (key, value, ...args) => {
      // node-redis style: set(key, value, { EX: seconds }) -> ioredis "EX", seconds
      const opts = args[0] as { EX?: number } | undefined;
      if (opts && typeof opts === "object" && typeof opts.EX === "number") {
        return redis.set(key, value, "EX", opts.EX);
      }
      return redis.set(key, value);
    },
    del: (...keys) => redis.del(...keys),
    exists: (...keys) => redis.exists(...keys),
    ttl: (key) => redis.ttl(key),
    expire: (key, seconds) => redis.expire(key, seconds),
    hGet: (key, field) => redis.hget(key, field),
    hSet: (key, field, value) => redis.hset(key, field, value),
    hGetAll: (key) => redis.hgetall(key),
  };
}
