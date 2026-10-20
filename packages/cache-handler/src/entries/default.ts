/**
 * Built-in `cacheHandlers.default` module that `withCache` points Next at: memory values with tag
 * invalidation shared through Redis, configured from the environment.
 */

import { createLocalCacheHandler } from "../data-cache/local.js";

export default createLocalCacheHandler();
