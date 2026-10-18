import type {
  CacheControl,
  CacheHandlerContext,
  CacheHandlerGetMeta,
  CacheHandlerValue,
  CacheValue,
  LifespanParameters,
  RevalidateTagDurations,
} from "../types.js";
import { calculateLifespan } from "./lifespan.js";

/**
 * Header in which Next.js passes the tags of a page or route handler entry
 * (explicit `cacheTag`/`fetch` tags and the implicit `_N_T_` path tags).
 */
export const NEXT_CACHE_TAGS_HEADER = "x-next-cache-tags";

/**
 * How long an entry is kept past its revalidate period by default, as a
 * multiple of that period, so Next.js can serve it stale while it regenerates.
 */
export const DEFAULT_EXPIRE_FACTOR = 2;

function getHeaderTags(value: CacheValue | null | undefined): string[] {
  if (
    !value ||
    (value.kind !== "APP_PAGE" && value.kind !== "APP_ROUTE" && value.kind !== "PAGES")
  ) {
    return [];
  }
  const header = value.headers?.[NEXT_CACHE_TAGS_HEADER];
  const joined = Array.isArray(header) ? header.join(",") : header;
  return joined ? joined.split(",").filter(Boolean) : [];
}

/**
 * Tags of an entry being stored: `ctx.tags` (fetch and `unstable_cache`) and
 * the `x-next-cache-tags` header (pages and route handlers).
 */
export function getEntryTags(value: CacheValue | null, context?: CacheHandlerContext): string[] {
  return [...new Set([...(context?.tags ?? []), ...getHeaderTags(value)])];
}

/**
 * Every tag a read must check: the stored ones, the header's (entries written
 * before tags were read from it stored none), and the request's soft and
 * implicit tags.
 */
export function getTagsToCheck(entry: CacheHandlerValue, meta?: CacheHandlerGetMeta): string[] {
  return [
    ...new Set([
      ...entry.tags,
      ...getHeaderTags(entry.value),
      ...(meta?.tags ?? []),
      ...(meta?.softTags ?? []),
      ...(meta?.implicitTags ?? []),
    ]),
  ];
}

/**
 * The lifetime Next.js gave an entry: `ctx.cacheControl` for pages and route
 * handlers, the value's own `revalidate` for fetch data. An explicit
 * `ctx.revalidate` (older callers) still wins over the fetch value's.
 */
export function getCacheControl(
  value: CacheValue | null,
  context?: CacheHandlerContext,
): CacheControl | undefined {
  if (context?.cacheControl) return context.cacheControl;
  if (context?.revalidate !== undefined) return { revalidate: context.revalidate };
  if (value?.kind === "FETCH") return { revalidate: value.revalidate };
  return undefined;
}

/**
 * Lifespan of an entry: stale after its revalidate period, kept for
 * `expireFactor` times that period so Next.js can serve it stale while it
 * regenerates, and never past Next.js's `expire`.
 */
export function getEntryLifespan(
  cacheControl: CacheControl | undefined,
  defaultTTL: number | undefined,
  expireFactor: number,
): LifespanParameters | null {
  const revalidate = cacheControl?.revalidate;
  const expire = cacheControl?.expire;
  if (typeof revalidate === "number" && revalidate > 0) {
    let expireAge = Math.ceil(revalidate * expireFactor);
    if (typeof expire === "number") expireAge = Math.min(expireAge, expire);
    return calculateLifespan(revalidate, defaultTTL, Math.max(expireAge, revalidate));
  }
  if (revalidate === false && typeof expire === "number") {
    return calculateLifespan(expire, defaultTTL);
  }
  return calculateLifespan(revalidate, defaultTTL);
}

/**
 * When a tag was revalidated, in milliseconds since the epoch: entries older
 * than `stale` are stale, and entries older than `expired` stop being served
 * once `expired` has passed.
 */
export interface TagRevalidation {
  stale: number;
  expired?: number;
}

/**
 * The record `revalidateTag(tags, durations)` stores for a tag, as Next.js's
 * own tags manifest does: without durations the tag expires now; with them it
 * is stale now and expires after `durations.expire` seconds.
 */
export function createTagRevalidation(
  durations: RevalidateTagDurations | string | undefined,
  now: number,
): TagRevalidation {
  if (typeof durations === "object" && durations.expire !== 0) {
    return {
      stale: now,
      expired: durations.expire === undefined ? undefined : now + durations.expire * 1000,
    };
  }
  return { stale: now, expired: now };
}

/**
 * Encodes a tag record for Redis: `"<time>"` for an immediate expiry (the
 * format older versions wrote and read) or `"<stale>:<expired>"`. Older
 * readers parse the latter with `Number.parseInt`, which keeps `<stale>`, so
 * they expire the entry: safe while versions are mixed during a rollout.
 */
export function encodeTagRevalidation(record: TagRevalidation): string {
  if (record.expired === record.stale) return String(record.stale);
  return `${record.stale}:${record.expired ?? ""}`;
}

export function decodeTagRevalidation(raw: string | null): TagRevalidation | undefined {
  if (!raw) return undefined;
  const [staleText, expiredText] = raw.split(":");
  const stale = Number(staleText);
  if (!Number.isFinite(stale)) return undefined;
  if (expiredText === undefined) return { stale, expired: stale };
  const expired = Number(expiredText);
  return { stale, expired: expiredText && Number.isFinite(expired) ? expired : undefined };
}

export type TagFreshness = "fresh" | "stale" | "expired";

/**
 * Freshness of an entry last modified at `lastModified` given its tags'
 * records, by the rules of Next.js's `areTagsExpired`/`areTagsStale`, except
 * that a revalidation in the same millisecond as the write also counts: at
 * worst that costs one extra regeneration. A tag never expires before it was
 * marked stale, so an immediate expiry holds even when this server's clock is
 * behind the one that wrote it.
 */
export function getTagFreshness(
  records: ReadonlyArray<TagRevalidation | undefined>,
  lastModified: number,
  now: number,
): TagFreshness {
  let freshness: TagFreshness = "fresh";
  for (const record of records) {
    if (!record) continue;
    const { stale, expired } = record;
    if (expired !== undefined && expired >= lastModified && expired <= Math.max(now, stale)) {
      return "expired";
    }
    if (stale >= lastModified) freshness = "stale";
  }
  return freshness;
}

/**
 * Next.js decides staleness itself, from `lastModified` and the revalidate
 * period, and has no other way to hear that a handler's tag made an entry
 * stale. Returns a `lastModified` far enough back that Next.js treats the
 * entry as stale and regenerates it in the background, or null when the entry
 * has no revalidate period and so can only be treated as expired.
 */
export function getStaleLastModified(
  entry: CacheHandlerValue,
  meta: CacheHandlerGetMeta | undefined,
  now: number,
): number | null {
  const revalidate =
    entry.value.kind === "FETCH"
      ? meta?.revalidate || entry.value.revalidate
      : entry.cacheControl?.revalidate;
  if (typeof revalidate !== "number" || revalidate <= 0) return null;
  return Math.min(entry.lastModified, now - revalidate * 1000 - 1);
}
