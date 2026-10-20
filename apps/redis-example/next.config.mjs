import { withCache } from "@mrjasonroy/cache-components-cache-handler";

// Runtime settings come from the environment: REDIS_URL (unset → memory), CACHE_KEY_PREFIX,
// CACHE_DEBUG. `useCache: "redis"` puts plain "use cache" in Redis too, so every entry this
// example makes is visible with redis-cli.
export default withCache({ cacheComponents: true }, { useCache: "redis" });
