import { MemoryCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

// Next.js expects a class that it will instantiate
export default class NextCacheHandler extends MemoryCacheHandler {
  constructor(options) {
    super({
      ...options,
      maxItemsNumber: 100,
      defaultTTL: 3600,
    });
  }
}
