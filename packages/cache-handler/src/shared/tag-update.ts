/**
 * Monotonic tag-record writes.
 *
 * Writers send their updates concurrently, and a write can reach Redis after a newer one from
 * another instance was acknowledged. A plain `HSET` of the whole record then replaced the newer
 * record with the older one, and an entry cached between the two revalidations read as fresh. So
 * each update is merged into the stored record by a script, in the order the updates were made
 * (by `stale`, the update time), not the order they arrive:
 *
 * - newer than the stored record (`stale` above it): it applies as `applyUpdate` would: `stale`
 *   becomes the update's, and `expired` too unless the update has none (durations without
 *   `expire`), which keeps the stored one;
 * - older: the stored record stays. Its `expired` is kept too; only a record without one takes
 *   the older update's (applying the older update first would have set it, and the newer update
 *   kept it);
 * - made in the same millisecond: `stale` is unchanged and the earlier `expired` wins, so an
 *   immediate revalidation is never weakened by a concurrent one with durations.
 *
 * A plain maximum of `expired` would be wrong: `revalidateTag(tag, "max")` followed by an
 * immediate `revalidateTag(tag)` must expire entries at once, not a year later.
 *
 * The script touches one key (`<prefix>tags`), so it runs on a Cluster. It is sent with EVALSHA,
 * and with EVAL when the server does not have it cached yet (NOSCRIPT). The index stays monotonic
 * with `ZADD GT` (Redis 6.2+, Valkey).
 */

import type { TagRecord } from "./tag-store.js";

/**
 * One update: when it was made and, unless it keeps the stored one, its `expired`.
 */
export interface TagUpdate {
  stale: number;
  expired?: number;
}

/**
 * `KEYS[1]` = the tags hash; `ARGV` = tag, stale, expired (`""` to keep), repeated. Timestamps
 * stay strings: Lua 5.1 prints large numbers in exponent form.
 */
export const UPDATE_TAGS_SCRIPT = `local key = KEYS[1]
for i = 1, #ARGV, 3 do
  local tag, s, e = ARGV[i], ARGV[i + 1], ARGV[i + 2]
  local cs, ce = '', ''
  local current = redis.call('HGET', key, tag)
  if current then
    local comma = string.find(current, ',', 1, true)
    if comma then
      cs = string.sub(current, 1, comma - 1)
      ce = string.sub(current, comma + 1)
    end
  end
  local ns, ne
  if cs == '' or tonumber(s) > tonumber(cs) then
    ns = s
    if e ~= '' then ne = e else ne = ce end
  elseif tonumber(s) < tonumber(cs) then
    ns = cs
    if ce ~= '' then ne = ce else ne = e end
  else
    ns = cs
    if e == '' then ne = ce
    elseif ce == '' then ne = e
    elseif tonumber(e) < tonumber(ce) then ne = e
    else ne = ce end
  end
  redis.call('HSET', key, tag, ns .. ',' .. ne)
end
return #ARGV / 3`;

/**
 * SHA1 of {@link UPDATE_TAGS_SCRIPT}, for EVALSHA. A unit test keeps it in step with the script.
 */
export const UPDATE_TAGS_SHA = "bf03bd390c7b4fa57584737835e3dff24acd86f7";

/**
 * {@link UPDATE_TAGS_SCRIPT}'s merge, for local state and the test double.
 */
export function mergeUpdate(current: TagRecord | undefined, update: TagUpdate): TagRecord {
  const stale = current?.stale;
  const expired = current?.expired;
  if (stale === undefined || update.stale > stale) {
    return { stale: update.stale, expired: update.expired ?? expired };
  }
  if (update.stale < stale) return { stale, expired: expired ?? update.expired };
  if (update.expired === undefined) return { stale, expired };
  if (expired === undefined) return { stale, expired: update.expired };
  return { stale, expired: Math.min(update.expired, expired) };
}

/**
 * The script's arguments for `updates`.
 */
export function updateArgs(updates: Map<string, TagUpdate>): string[] {
  const args: string[] = [];
  for (const [tag, update] of updates) {
    args.push(
      tag,
      String(update.stale),
      update.expired === undefined ? "" : String(update.expired),
    );
  }
  return args;
}
