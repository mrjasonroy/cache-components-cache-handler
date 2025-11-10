import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // NO cacheComponents - testing legacy caching
  cacheComponents: false,

  // ISR cache handler - should handle fetch() and unstable_cache
  cacheHandler: resolve(__dirname, "./cache-handler.mjs"),
};

export default nextConfig;
