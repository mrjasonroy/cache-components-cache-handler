/**
 * @mrjasonroy/cache-components-cache-handler
 *
 * Cache handlers for Next.js 16+: pages and route handlers (`cacheHandler`), "use cache" and
 * "use cache: remote" (`cacheHandlers`). `withCache(nextConfig)` configures all of them.
 */

// =============================================================================
// The one public way: withCache, plus the handlers it points Next at
// =============================================================================

export {
  createLocalCacheHandler,
  type LocalCacheHandlerOptions,
} from "./data-cache/local.js";
export {
  createRemoteCacheHandler,
  type RemoteCacheHandlerOptions,
} from "./data-cache/remote.js";
export {
  createPageCacheHandler,
  type PageCacheHandlerOptions,
  RedisCacheHandler,
} from "./handlers/redis.js";
export type {
  PageCacheControl,
  PageCacheGetContext,
  PageCacheHandlerContext,
  PageCacheHandlerValue,
  PageCacheSetContext,
  PageCacheValue,
} from "./handlers/page-types.js";
export {
  type NextConfigFunction,
  type WithCacheConfig,
  type WithCacheOptions,
  withCache,
} from "./helpers/with-cache.js";
export {
  type AttachElastiCacheIamAuthOptions,
  attachElastiCacheIamAuth,
  type ElastiCacheIamAuth,
} from "./helpers/elasticache-iam.js";
export {
  type FlushCacheOptions,
  type FlushCacheResult,
  flushCache,
} from "./shared/flush.js";
export type {
  AwsCredentials,
  AwsCredentialsProvider,
  ElastiCacheIamOptions,
} from "./shared/elasticache-iam.js";
export { type CacheLogger, setCacheLogger } from "./shared/logger.js";
export type { MemoryOptions } from "./shared/memory-budget.js";
export { type CacheOptions, closeCache } from "./shared/runtime.js";

// =============================================================================
// Deprecated 16.4.2 API, removed in 16.5. Each keeps working in 16.4.x. Functions are exported
// wrapped (shared/deprecation.ts) so an application's first call logs a one-time warning; the
// classes warn when constructed. The package's own internal uses never warn.
// =============================================================================

import { createCacheHandler as createCacheHandlerImpl } from "./data-cache/factory.js";
import { createIoredisAdapter as createIoredisAdapterImpl } from "./data-cache/ioredis-adapter.js";
import { createMemoryDataCacheHandler as createMemoryDataCacheHandlerImpl } from "./data-cache/memory.js";
import { createRedisDataCacheHandler as createRedisDataCacheHandlerImpl } from "./data-cache/redis.js";
import { createCompositeHandler as createCompositeHandlerImpl } from "./handlers/composite.js";
import { createMemoryCacheHandler as createMemoryCacheHandlerImpl } from "./handlers/memory.js";
import {
  bufferToString as bufferToStringImpl,
  stringToBuffer as stringToBufferImpl,
} from "./helpers/buffer.js";
import { isImplicitTag as isImplicitTagImpl } from "./helpers/is-implicit-tag.js";
import {
  calculateLifespan as calculateLifespanImpl,
  isExpired as isExpiredImpl,
} from "./helpers/lifespan.js";
import {
  createCacheConfig as createCacheConfigImpl,
  createCacheConfigWithProfiles as createCacheConfigWithProfilesImpl,
} from "./helpers/next-config.js";
import {
  jsonReplacer as jsonReplacerImpl,
  jsonReviver as jsonReviverImpl,
} from "./helpers/serialization.js";
import { deprecatedFunction } from "./shared/deprecation.js";

const NEXT14_HELPER = "It is internal to the Next 14 handlers and has no replacement.";

export {
  CompositeHandler,
  type CompositeHandlerOptions,
} from "./handlers/composite.js";
// Renamed PageCacheHandlerOptions
export type { RedisCacheHandlerOptions } from "./handlers/redis.js";
export {
  MemoryCacheHandler,
  type MemoryCacheHandlerOptions,
} from "./handlers/memory.js";
export type {
  CacheHandler,
  CacheHandlerContext,
  CacheHandlerGetMeta,
  CacheHandlerOptions,
  CacheHandlerValue,
  CacheValue,
  LifespanParameters,
} from "./types.js";
export { IMPLICIT_TAG_PREFIX } from "./types.js";

/**
 * @deprecated The memory fallback is built into every handler; use `withCache`. Still works in
 * 16.4.x; removed in 16.5.
 */
export const createCompositeHandler = deprecatedFunction(
  createCompositeHandlerImpl,
  "createCompositeHandler",
  "Use withCache(nextConfig): every handler has a built-in memory fallback.",
);

/**
 * @deprecated Use `withCache` without `REDIS_URL`: memory only is the no-URL mode. Still works in
 * 16.4.x; removed in 16.5.
 */
export const createMemoryCacheHandler = deprecatedFunction(
  createMemoryCacheHandlerImpl,
  "createMemoryCacheHandler",
  "Use withCache(nextConfig) without REDIS_URL.",
);

/** @deprecated Internal to the Next 14 handlers; no replacement. Removed in 16.5. */
export const bufferToString = deprecatedFunction(
  bufferToStringImpl,
  "bufferToString",
  NEXT14_HELPER,
);

/** @deprecated Internal to the Next 14 handlers; no replacement. Removed in 16.5. */
export const stringToBuffer = deprecatedFunction(
  stringToBufferImpl,
  "stringToBuffer",
  NEXT14_HELPER,
);

/** @deprecated Internal to the Next 14 handlers; no replacement. Removed in 16.5. */
export const isImplicitTag = deprecatedFunction(isImplicitTagImpl, "isImplicitTag", NEXT14_HELPER);

/** @deprecated Internal to the Next 14 handlers; no replacement. Removed in 16.5. */
export const calculateLifespan = deprecatedFunction(
  calculateLifespanImpl,
  "calculateLifespan",
  NEXT14_HELPER,
);

/** @deprecated Internal to the Next 14 handlers; no replacement. Removed in 16.5. */
export const isExpired = deprecatedFunction(isExpiredImpl, "isExpired", NEXT14_HELPER);

/** @deprecated Internal to the Next 14 handlers; no replacement. Removed in 16.5. */
export const jsonReplacer = deprecatedFunction(jsonReplacerImpl, "jsonReplacer", NEXT14_HELPER);

/** @deprecated Internal to the Next 14 handlers; no replacement. Removed in 16.5. */
export const jsonReviver = deprecatedFunction(jsonReviverImpl, "jsonReviver", NEXT14_HELPER);

// =============================================================================
// Deprecated 16.4.2 data cache stack, removed in 16.5: use withCache, or
// createRemoteCacheHandler / createLocalCacheHandler
// =============================================================================

export type {
  CacheHandlerOptions as DataCacheHandlerOptions,
  CacheHandlerType,
} from "./data-cache/factory.js";
export type { MemoryDataCacheHandlerOptions } from "./data-cache/memory.js";
export type { RedisClient, RedisDataCacheHandlerOptions } from "./data-cache/redis.js";
export type { IoredisLike } from "./data-cache/ioredis-adapter.js";
export type {
  DataCacheEntry,
  DataCacheHandler,
  Timestamp,
} from "./data-cache/types.js";
export type { CacheHandlerConfig } from "./helpers/next-config.js";

/**
 * @deprecated The 16.4.2 data cache factory. Use `withCache(nextConfig)`, or
 * `createRemoteCacheHandler` / `createLocalCacheHandler` in a custom handler file. Still works in
 * 16.4.x; removed in 16.5.
 */
export const createCacheHandler = deprecatedFunction(
  createCacheHandlerImpl,
  "createCacheHandler",
  "Use withCache(nextConfig), or createRemoteCacheHandler / createLocalCacheHandler in a custom handler file.",
);

/**
 * @deprecated Use `createLocalCacheHandler`. Still works in 16.4.x; removed in 16.5.
 */
export const createMemoryDataCacheHandler = deprecatedFunction(
  createMemoryDataCacheHandlerImpl,
  "createMemoryDataCacheHandler",
  "Use withCache(nextConfig), or createLocalCacheHandler in a custom handler file.",
);

/**
 * @deprecated Use `createRemoteCacheHandler({ client })` with an ioredis client. Still works in
 * 16.4.x; removed in 16.5.
 */
export const createRedisDataCacheHandler = deprecatedFunction(
  createRedisDataCacheHandlerImpl,
  "createRedisDataCacheHandler",
  "Use withCache(nextConfig), or createRemoteCacheHandler({ client }) in a custom handler file.",
);

/**
 * @deprecated Pass the ioredis client to `createRemoteCacheHandler({ client })`. Still works in
 * 16.4.x; removed in 16.5.
 */
export const createIoredisAdapter = deprecatedFunction(
  createIoredisAdapterImpl,
  "createIoredisAdapter",
  "Pass the ioredis client to createRemoteCacheHandler({ client }).",
);

/**
 * @deprecated Use `withCache(nextConfig)`. Still works in 16.4.x; removed in 16.5.
 */
export const createCacheConfig = deprecatedFunction(
  createCacheConfigImpl,
  "createCacheConfig",
  "Use withCache(nextConfig).",
);

/**
 * @deprecated Use `withCache(nextConfig, { handlers })`. Still works in 16.4.x; removed in 16.5.
 */
export const createCacheConfigWithProfiles = deprecatedFunction(
  createCacheConfigWithProfilesImpl,
  "createCacheConfigWithProfiles",
  "Use withCache(nextConfig, { handlers }).",
);
