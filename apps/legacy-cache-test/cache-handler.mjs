import { MemoryCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

// Next.js expects a class that it will instantiate
export default class NextCacheHandler extends MemoryCacheHandler {
  constructor(options) {
    console.log("[LegacyCacheHandler] Initializing with options:", options);
    super({
      ...options,
      maxItemsNumber: 100,
      defaultTTL: 3600,
    });
  }

  async get(key) {
    console.log("[LegacyCacheHandler] GET:", key);
    const result = await super.get(key);
    console.log("[LegacyCacheHandler] GET result:", result ? "HIT" : "MISS");
    return result;
  }

  async set(key, value) {
    console.log("[LegacyCacheHandler] SET:", key, "kind:", value?.kind);
    return await super.set(key, value);
  }
}
