import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withCache } from "@mrjasonroy/cache-components-cache-handler";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The CI lanes pick the backend with env vars only: REDIS_URL / ELASTICACHE_* (unset → memory),
// E2E_USE_CACHE=redis to put plain "use cache" in Redis too, and E2E_CUSTOM_HANDLERS=1 to load
// the hand-written handler files in ./cache instead of the built-in ones.
const useCache = process.env.E2E_USE_CACHE === "redis" ? "redis" : "memory";
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

export default withCache(nextConfig, { useCache, handlers });
