import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  cacheComponents: true,

  // ISR cache handler (for traditional Next.js caching)
  cacheHandler: resolve(__dirname, "./cache-handler.mjs"),

  // Disable default in-memory caching for "use cache"
  cacheMaxMemorySize: 0,

  // Data cache handlers for "use cache" directive
  cacheHandlers: {
    // "use cache" uses this
    default: resolve(__dirname, "./data-cache-handler.mjs"),
    // "use cache: remote" uses this - THE IMPORTANT ONE for production
    remote: resolve(__dirname, "./data-cache-handler.mjs"),
  },

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

export default nextConfig;
