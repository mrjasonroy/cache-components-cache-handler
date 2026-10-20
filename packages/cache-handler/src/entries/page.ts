/**
 * Built-in `cacheHandler` module that `withCache` points Next at: the page handler configured
 * from the environment.
 */

import { createRedisCacheHandler } from "../handlers/redis.js";

export default createRedisCacheHandler();
