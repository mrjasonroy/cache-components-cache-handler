import { withCache } from "@mrjasonroy/cache-components-cache-handler";

export default withCache(
  { cacheComponents: true, experimental: { cpus: 1 } },
  { useCache: "redis", pages: false },
);
