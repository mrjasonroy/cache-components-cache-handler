import { createPageCacheHandler } from "@mrjasonroy/cache-components-cache-handler";
import { client } from "./redis.mjs";

export default createPageCacheHandler({ client });
