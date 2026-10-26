/**
 * Built-in `cacheHandlers.remote` module that `withCache` points Next at (`"use cache: remote"`):
 * the Redis data handler configured from the environment.
 */

import { createRemoteCacheHandler } from "../data-cache/remote.js";

export default createRemoteCacheHandler();
