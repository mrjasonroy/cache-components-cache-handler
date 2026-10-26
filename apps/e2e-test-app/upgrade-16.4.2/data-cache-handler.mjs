// The 16.4.2 README's quick start, unchanged: one data cache handler for "use cache" and
// "use cache: remote", configured from REDIS_URL. Used by the E2E_CONFIG=16.4.2 lane.
import { createCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

export default createCacheHandler({ type: "redis" });
