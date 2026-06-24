import type { RedisClient } from "./redis.js";

/**
 * Minimal structural type for an ioredis-compatible client.
 *
 * Only the methods the data cache handler relies on are declared, so consumers
 * don't need ioredis' types in scope to call {@link createIoredisAdapter}. Both
 * ioredis `Redis` and `Cluster` instances satisfy this shape.
 */
export interface IoredisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  ttl(key: string): Promise<number>;
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
    hGet: (key, field) => redis.hget(key, field),
    hSet: (key, field, value) => redis.hset(key, field, value),
    hGetAll: (key) => redis.hgetall(key),
  };
}
