import type { LifespanParameters } from "../types.js";

/**
 * Calculate lifespan parameters from revalidate value
 * CRITICAL: All timestamps are in SECONDS, not milliseconds
 *
 * @param revalidate - Revalidation period in seconds, or false to disable
 * @param defaultTTL - Default TTL in seconds if revalidate is undefined
 * @returns Lifespan parameters or null if no expiration
 */
export function calculateLifespan(
  revalidate: number | false | undefined,
  defaultTTL?: number,
): LifespanParameters | null {
  // If revalidate is explicitly false, no expiration
  if (revalidate === false) {
    return null;
  }

  // Use revalidate value or default TTL
  const ttlSeconds = typeof revalidate === "number" ? revalidate : defaultTTL;

  // If no TTL specified, no expiration
  if (!ttlSeconds) {
    return null;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);

  return {
    lastModifiedAt: nowSeconds,
    staleAt: nowSeconds + ttlSeconds,
    expireAt: nowSeconds + ttlSeconds,
    staleAge: ttlSeconds,
    expireAge: ttlSeconds,
    revalidate,
  };
}

/**
 * Check if a cache entry has expired based on its lifespan
 *
 * @param lifespan - Lifespan parameters (null means never expires)
 * @returns True if expired, false otherwise
 */
export function isExpired(lifespan: LifespanParameters | null): boolean {
  if (!lifespan) {
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  return nowSeconds >= lifespan.expireAt;
}

/**
 * Compute remaining Redis EX TTL in seconds from lifespan parameters.
 * expireAt is epoch seconds (see calculateLifespan).
 */
export function redisTtlSecondsFromLifespan(
  lifespan: LifespanParameters | null,
): number | undefined {
  if (!lifespan?.expireAt) return undefined;
  return lifespan.expireAt - Math.floor(Date.now() / 1000);
}
