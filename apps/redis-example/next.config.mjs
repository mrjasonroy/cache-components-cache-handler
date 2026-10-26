import { withCache } from "@mrjasonroy/cache-components-cache-handler";

// Runtime settings come from the environment: REDIS_URL (unset → memory), CACHE_KEY_PREFIX,
// CACHE_DEBUG. The example's cached functions use "use cache: remote", so every entry they make
// is visible with redis-cli.
export default withCache({ cacheComponents: true });
