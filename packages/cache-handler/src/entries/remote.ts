/**
 * Built-in `cacheHandlers.remote` module that `withCache` points Next at (and `default` with
 * `useCache: "redis"`): the Redis data handler configured from the environment.
 */

import { createRemoteCacheHandler } from "../data-cache/remote.js";

export default createRemoteCacheHandler();
