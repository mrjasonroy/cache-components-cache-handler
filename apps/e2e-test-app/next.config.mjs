import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withCache } from "@mrjasonroy/cache-components-cache-handler";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The CI lanes pick the backend with env vars only: REDIS_URL / ELASTICACHE_* (unset → memory),
// and E2E_CUSTOM_HANDLERS=1 to load the hand-written handler files in ./cache instead of the
// built-in ones. E2E_CONFIG=16.4.2 skips withCache and wires the app the way the 16.4.2 README
// did (./upgrade-16.4.2).
const handlers =
  process.env.E2E_CUSTOM_HANDLERS === "1"
    ? {
        page: resolve(__dirname, "./cache/page.mjs"),
        remote: resolve(__dirname, "./cache/remote.mjs"),
      }
    : undefined;

/** @type {import('next').NextConfig} */
const nextConfig = {
  cacheComponents: true,

  // Custom cacheLife profiles for testing
  cacheLife: {
    // Custom profile: 2 weeks with daily revalidation
    biweekly: {
      stale: 1209600, // 14 days in seconds
      revalidate: 86400, // 1 day in seconds
      expire: 1209600, // 14 days in seconds
    },
    // Custom short profile for testing
    short: {
      stale: 5, // 5 seconds
      revalidate: 2, // 2 seconds
      expire: 10, // 10 seconds
    },
  },
};

// 16.4.2's documented setup: its handler files in cacheHandler / cacheHandlers, and
// cacheMaxMemorySize: 0. No withCache.
const config16_4_2 = {
  ...nextConfig,
  cacheHandler: resolve(__dirname, "./upgrade-16.4.2/cache-handler.mjs"),
  cacheHandlers: {
    default: resolve(__dirname, "./upgrade-16.4.2/data-cache-handler.mjs"),
    remote: resolve(__dirname, "./upgrade-16.4.2/data-cache-handler.mjs"),
  },
  cacheMaxMemorySize: 0,
};

export default process.env.E2E_CONFIG === "16.4.2"
  ? config16_4_2
  : withCache(nextConfig, { handlers });
