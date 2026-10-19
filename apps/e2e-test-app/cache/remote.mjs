import { createRemoteCacheHandler } from "@mrjasonroy/cache-components-cache-handler";
import { client } from "./redis.mjs";

export default createRemoteCacheHandler({ client });
