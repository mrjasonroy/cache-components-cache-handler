/**
 * The tag state of each key, one per key in the process (DEC-6), on `globalThis` (DEC-5). A key is
 * a connection and key prefix: a connection of the package's own by its pool key, an application
 * client by the client object (in a `WeakMap`, so a dropped client takes its states with it).
 *
 * The live runtime of a key uses that key's state, and is its owner. `closeCache` drops a state
 * once its owner is closed and nothing in it is unsent; one with updates Redis has not taken is
 * kept, and the next runtime of the key takes it over. A closed tag store never writes to its own
 * state: an update forwards to the live runtime of its key, and a failed send requeues into
 * whatever state the key has now. So there is one place a key's pending invalidations can be.
 */

import type { KeyTagState, TagStore } from "./tag-store.js";

/** Which state a runtime uses. */
export type TagStateKey =
  | { readonly pooled: string; readonly keyPrefix: string }
  | { readonly client: object; readonly keyPrefix: string };

interface TagStates {
  pooled: Map<string, KeyTagState>;
  clients: WeakMap<object, Map<string, KeyTagState>>;
}

const TAG_STATES_KEY = Symbol.for("@mrjasonroy/cache-components-cache-handler/tag-states");

function getTagStates(): TagStates {
  const store = globalThis as unknown as Record<symbol, TagStates | undefined>;
  let states = store[TAG_STATES_KEY];
  if (!states) {
    states = { pooled: new Map(), clients: new WeakMap() };
    store[TAG_STATES_KEY] = states;
  }
  return states;
}

/** The map holding `key`'s state, and its key in that map. */
function slotOf(key: TagStateKey, create: boolean): [Map<string, KeyTagState>, string] | undefined {
  const states = getTagStates();
  if ("pooled" in key) return [states.pooled, `${key.pooled}|${key.keyPrefix}`];
  let byPrefix = states.clients.get(key.client);
  if (!byPrefix) {
    if (!create) return undefined;
    byPrefix = new Map();
    states.clients.set(key.client, byPrefix);
  }
  return [byPrefix, key.keyPrefix];
}

/** The state of `key`, created empty if it has none. */
export function tagStateOf(key: TagStateKey): KeyTagState {
  const [map, slotKey] = slotOf(key, true) as [Map<string, KeyTagState>, string];
  let state = map.get(slotKey);
  if (!state) {
    state = { records: new Map(), unsent: new Map() };
    map.set(slotKey, state);
  }
  return state;
}

/**
 * Drop the state of `key` if `owner` still owns it and nothing in it is unsent. A state a newer
 * runtime has taken over, or with updates Redis has not taken, is kept.
 */
export function releaseTagState(key: TagStateKey, owner: TagStore): void {
  const slot = slotOf(key, false);
  if (!slot) return;
  const [map, slotKey] = slot;
  const state = map.get(slotKey);
  if (state?.owner === owner && state.unsent.size === 0) map.delete(slotKey);
  if (map.size === 0 && "client" in key) getTagStates().clients.delete(key.client);
}

/**
 * Forget every state. Test-only.
 * @internal
 */
export function clearTagStatesForTests(): void {
  const states = getTagStates();
  states.pooled.clear();
  states.clients = new WeakMap();
}
