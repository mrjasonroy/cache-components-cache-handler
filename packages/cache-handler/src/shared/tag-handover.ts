/**
 * Where `closeCache` leaves a closed runtime's tag state for the next runtime of the same
 * connection and key prefix in this process (DEC-6). Kept on `globalThis` (DEC-5).
 *
 * Retention: an entry lives only as long as it may hold work. Taking it (a new runtime adopting
 * it) removes it, and `closeCache` removes one nobody adopted once its last send leaves nothing
 * unsent. What stays is a hand-over with invalidations Redis has not taken:
 * - for a connection of the package's own, keyed by the connection's pool key and the prefix, so
 *   bounded by the distinct option sets times prefixes, and the same options reconnect to it;
 * - for an application client, keyed by the client object in a `WeakMap`, so it goes with a
 *   client the application drops.
 * Pending invalidations are never dropped to bound it.
 */

import type { TagHandover } from "./tag-store.js";

/** Which hand-over a runtime gives and takes. */
export type HandoverKey =
  | { readonly pooled: string; readonly keyPrefix: string }
  | { readonly client: object; readonly keyPrefix: string };

interface PendingTags {
  pooled: Map<string, TagHandover>;
  clients: WeakMap<object, Map<string, TagHandover>>;
}

const PENDING_TAGS_KEY = Symbol.for("@mrjasonroy/cache-components-cache-handler/pending-tags");

function getPendingTags(): PendingTags {
  const store = globalThis as unknown as Record<symbol, PendingTags | undefined>;
  let pending = store[PENDING_TAGS_KEY];
  if (!pending) {
    pending = { pooled: new Map(), clients: new WeakMap() };
    store[PENDING_TAGS_KEY] = pending;
  }
  return pending;
}

/** The map holding `key`'s hand-over, and its key in that map. */
function slotOf(key: HandoverKey, create: boolean): [Map<string, TagHandover>, string] | undefined {
  const pending = getPendingTags();
  if ("pooled" in key) return [pending.pooled, `${key.pooled}|${key.keyPrefix}`];
  let byPrefix = pending.clients.get(key.client);
  if (!byPrefix) {
    if (!create) return undefined;
    byPrefix = new Map();
    pending.clients.set(key.client, byPrefix);
  }
  return [byPrefix, key.keyPrefix];
}

/** Leave `handover` for the next runtime of `key`. */
export function publishHandover(key: HandoverKey, handover: TagHandover): void {
  const [map, slotKey] = slotOf(key, true) as [Map<string, TagHandover>, string];
  map.set(slotKey, handover);
}

/** Take, and remove, the hand-over left for `key`, marking it adopted. */
export function takeHandover(key: HandoverKey): TagHandover | undefined {
  const slot = slotOf(key, false);
  if (!slot) return undefined;
  const [map, slotKey] = slot;
  const handover = map.get(slotKey);
  if (!handover) return undefined;
  map.delete(slotKey);
  handover.adopted = true;
  return handover;
}

/**
 * Remove `handover` if the slot of `key` still holds this very one and it has nothing left to
 * send: a newer close's state, or one with pending invalidations, is kept.
 */
export function releaseHandover(key: HandoverKey, handover: TagHandover): void {
  const slot = slotOf(key, false);
  if (!slot) return;
  const [map, slotKey] = slot;
  if (map.get(slotKey) === handover && handover.unsent.size === 0) map.delete(slotKey);
}

/**
 * For a closed store whose late send failed: leave its state again if nobody adopted it and the
 * slot holds no other.
 */
export function republishHandover(key: HandoverKey, handover: TagHandover): void {
  if (handover.adopted) return;
  const [map, slotKey] = slotOf(key, true) as [Map<string, TagHandover>, string];
  if (!map.has(slotKey)) map.set(slotKey, handover);
}

/**
 * Forget every hand-over. Test-only.
 * @internal
 */
export function clearHandoversForTests(): void {
  const pending = getPendingTags();
  pending.pooled.clear();
  pending.clients = new WeakMap();
}
