/**
 * Built-in `cacheHandler` module that `withCache` points Next at: the page handler configured
 * from the environment.
 */

import { createPageCacheHandler } from "../handlers/redis.js";

export default createPageCacheHandler();
