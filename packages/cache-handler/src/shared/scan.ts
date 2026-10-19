/**
 * SCAN helpers that work on a single Redis and on a Redis Cluster (every master is scanned).
 */

import type { Redis } from "ioredis";
import type { RedisClientLike } from "./connection.js";

const SCAN_COUNT = 500;

/**
 * True for an ioredis `Cluster`.
 */
export function isCluster(client: RedisClientLike): boolean {
  return typeof (client as { nodes?: unknown }).nodes === "function";
}

/**
 * Escape glob characters, so `value` matches itself in a SCAN `MATCH` pattern.
 */
export function escapeGlob(value: string): string {
  return value.replace(/[*?[\]\\]/g, "\\$&");
}

/**
 * The nodes to scan: every master of a Cluster, or the client itself.
 */
function scanNodes(client: RedisClientLike): Redis[] {
  if (isCluster(client)) {
    return (client as { nodes(role: "master"): Redis[] }).nodes("master");
  }
  return [client as Redis];
}

/**
 * Call `onBatch` with every batch of keys matching `pattern`, and the node they live on.
 */
export async function scanKeys(
  client: RedisClientLike,
  pattern: string,
  onBatch: (node: Redis, keys: string[]) => Promise<void>,
): Promise<void> {
  for (const node of scanNodes(client)) {
    let cursor = "0";
    do {
      const [next, keys] = await node.scan(cursor, "MATCH", pattern, "COUNT", SCAN_COUNT);
      cursor = next;
      if (keys.length > 0) await onBatch(node, keys);
    } while (cursor !== "0");
  }
}

/**
 * Delete every key matching `pattern` with UNLINK and return how many were deleted. On a Cluster,
 * keys of one node can sit in different slots, so they are unlinked one per command, pipelined.
 */
export async function unlinkMatching(client: RedisClientLike, pattern: string): Promise<number> {
  const cluster = isCluster(client);
  let deleted = 0;
  await scanKeys(client, pattern, async (node, keys) => {
    if (!cluster) {
      deleted += await node.unlink(...keys);
      return;
    }
    const pipeline = node.pipeline();
    for (const key of keys) pipeline.unlink(key);
    const results = (await pipeline.exec()) ?? [];
    for (const [error, count] of results) {
      if (error) throw error;
      deleted += Number(count);
    }
  });
  return deleted;
}
