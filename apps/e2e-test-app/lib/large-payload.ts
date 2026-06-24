import { cacheLife, cacheTag } from "next/cache";

export const PAYLOAD_ITEM_COUNT = 500;
export const PAYLOAD_UNICODE = "Ünïcödé ✓ 中文 日本語 🎉🚀 — quotes \" ' and \\ backslash";

/**
 * A deliberately large, deeply-nested, unicode-rich payload used to exercise
 * serialization of realistic RSC-sized data through the cache handler. If the
 * payload survives a cache round-trip intact (and stays stable across reloads),
 * the handler is serializing complex data correctly.
 */
export async function getLargePayload() {
  "use cache";
  cacheLife("hours");
  cacheTag("large-payload");

  const items = Array.from({ length: PAYLOAD_ITEM_COUNT }, (_, i) => ({
    id: i,
    label: `Item ${i} — ${PAYLOAD_UNICODE}`,
    nested: { value: i * 2, tags: [`tag-${i}`, `tag-${i + 1}`], flag: i % 2 === 0 },
  }));

  return {
    // A per-cache-write stamp so "stable across reloads" proves a cache hit.
    generatedAt: new Date().toISOString(),
    random: Math.random(),
    unicode: PAYLOAD_UNICODE,
    count: items.length,
    first: items[0],
    last: items[items.length - 1],
    items,
  };
}
