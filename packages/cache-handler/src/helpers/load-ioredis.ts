import { requireModule } from "../shared/node-require.js";

/**
 * Lazy load ioredis and return the constructor, so importing this package does not
 * require ioredis unless a Redis-family handler is actually created.
 */
export function loadIoredis(type: string): typeof import("ioredis").default {
  try {
    return requireModule<typeof import("ioredis").default>("ioredis");
  } catch {
    throw new Error(
      `ioredis is required for ${type} cache handler. Install it with: npm install ioredis`,
    );
  }
}
