/**
 * Reset the environment and process-wide state the handlers read. Test-only; not built.
 */

import { resetBuildInfoForTests } from "../handlers/build-info.js";
import { resetBuildOutputForTests } from "../handlers/build-output.js";
import { resetBuildIdForTests } from "../shared/build-id.js";
import { closeAllRedisConnections } from "../shared/connection.js";
import { clearAllMemoryStores } from "../shared/memory-store.js";
import { resetCacheRuntimesForTests } from "../shared/runtime.js";
import type { FakeRedis } from "./fake-redis.js";

const CACHE_ENV = [
  "REDIS_URL",
  "VALKEY_URL",
  "REDIS_PASSWORD",
  "ELASTICACHE_ENDPOINT",
  "ELASTICACHE_PORT",
  "ELASTICACHE_AUTH_TOKEN",
  "ELASTICACHE_TLS",
  "CACHE_KEY_PREFIX",
  "CACHE_REDIS",
  "CACHE_DEBUG",
  "CACHE_COMPRESSION",
  "NEXT_PHASE",
  "__NEXT_PRIVATE_STANDALONE_CONFIG",
  "NEXT_RUNTIME",
];

export async function resetCacheState(): Promise<void> {
  for (const name of CACHE_ENV) Reflect.deleteProperty(process.env, name);
  await closeAllRedisConnections();
  clearAllMemoryStores();
  resetCacheRuntimesForTests();
  resetBuildIdForTests();
  resetBuildOutputForTests();
  resetBuildInfoForTests();
}

/**
 * The fake as the ioredis client type the options take.
 */
export function asClient(fake: FakeRedis): import("ioredis").Redis {
  return fake as unknown as import("ioredis").Redis;
}
