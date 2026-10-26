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
 * Outcome of {@link unlinkMatching}.
 */
export interface UnlinkResult {
  /** Keys deleted. */
  deleted: number;
  /** Matching keys that could not be deleted (a Cluster slot migration that never settled). */
  failed: number;
}

/** A Cluster `-MOVED` / `-ASK` reply: the key's slot is migrating or has moved to another node. */
function isRedirection(error: unknown): boolean {
  return error instanceof Error && /^(MOVED|ASK) /.test(error.message);
}

/**
 * Delete every key matching `pattern` with UNLINK, one command per SCAN batch; on a single endpoint
 * that answers that with CROSSSLOT (ElastiCache Serverless), one per key. On a Cluster, keys of one node can sit in
 * different slots, so they are unlinked one per command, pipelined; a key answered with `-MOVED`
 * or `-ASK` (its slot is migrating) is retried once through the Cluster client, which follows
 * the redirection (bounded by its `maxRedirections`). A key that still fails is counted in
 * `failed` instead of throwing, so the caller can report a partial flush.
 */
export async function unlinkMatching(
  client: RedisClientLike,
  pattern: string,
): Promise<UnlinkResult> {
  const cluster = isCluster(client);
  let deleted = 0;
  let failed = 0;
  // A single endpoint that is sharded behind a proxy (ElastiCache Serverless reached with a plain
  // `Redis` client) refuses a multi-key UNLINK across slots with CROSSSLOT: from then on, one key
  // per command, pipelined.
  let crossSlot = false;
  await scanKeys(client, pattern, async (node, keys) => {
    if (!cluster && !crossSlot) {
      try {
        deleted += await node.unlink(...keys);
        return;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("CROSSSLOT")) throw error;
        crossSlot = true;
      }
    }
    const pipeline = node.pipeline();
    for (const key of keys) pipeline.unlink(key);
    const results = (await pipeline.exec()) ?? [];
    for (const [index, [error, count]] of results.entries()) {
      if (!error) {
        deleted += Number(count);
        continue;
      }
      if (!cluster || !isRedirection(error)) throw error;
      try {
        deleted += await (client as Redis).unlink(keys[index]);
      } catch {
        failed += 1;
      }
    }
  });
  return { deleted, failed };
}
