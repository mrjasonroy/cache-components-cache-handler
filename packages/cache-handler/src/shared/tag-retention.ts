/** Background tag retention, shared across handler module graphs (DEC-5). */
import type { RedisConnection } from "./connection.js";
import { MAX_ENTRY_AGE_SECONDS } from "./keys.js";

/** Two clock-skew windows: the invalidation writer and the maintenance process. */
export const TAG_RETENTION_MARGIN_MS = 10_000;
export const TAG_RETENTION_MS = MAX_ENTRY_AGE_SECONDS * 1000 + TAG_RETENTION_MARGIN_MS;
/** Maintenance is bounded and runs independently of requests. */
export const TAG_MAINTENANCE_INTERVAL_MS = 60_000;
export const TAG_PRUNE_BATCH_SIZE = 1_000;

interface Capability {
  supported: boolean;
  attempt: boolean;
  scriptRejected: boolean;
  retryOnReady: boolean;
  probing?: Promise<void>;
}
const CAPABILITIES_KEY = Symbol.for("@mrjasonroy/cache-components-cache-handler/tag-capabilities");

function capability(connection: RedisConnection): Capability {
  const global = globalThis as unknown as Record<symbol, WeakMap<object, Capability> | undefined>;
  let capabilities = global[CAPABILITIES_KEY];
  if (!capabilities) {
    capabilities = new WeakMap();
    global[CAPABILITIES_KEY] = capabilities;
  }
  let result = capabilities.get(connection);
  if (!result) {
    result = { supported: false, attempt: true, scriptRejected: false, retryOnReady: false };
    capabilities.set(connection, result);
  }
  return result;
}

/** Read without issuing a command, including before the background probe completes. */
export function supportsTagFieldExpiry(connection: RedisConnection): boolean {
  return capability(connection).supported;
}

/** Probe once per connection, off the request path; any failure selects the fallback. */
export async function probeTagFieldExpiry(connection: RedisConnection): Promise<void> {
  const state = capability(connection);
  if (!state.probing) {
    state.probing = (async () => {
      try {
        const reply = await connection.client.call("COMMAND", "INFO", "HPEXPIREAT");
        state.supported = !state.scriptRejected && Array.isArray(reply) && Array.isArray(reply[0]);
      } catch (error) {
        state.supported = false;
        state.retryOnReady =
          error instanceof Error &&
          error.name !== "ReplyError" &&
          !/unknown command|NOPERM/i.test(error.message);
      } finally {
        state.attempt = state.supported;
      }
    })();
  }
  await state.probing;
}

/**
 * Standalone Redis only: selection and both removals are atomic. A fresh hash write whose
 * ZADD is still in flight is protected by the merged record horizon, not just the index score.
 * Kept barriers / future deadlines are walked with an offset; concurrent deletions can postpone
 * a candidate until the next pass, but can never make it unsafe to delete.
 * ARGV: cutoff (now minus retention), batch size, offset.
 */
export const PRUNE_TAGS_SCRIPT = `local cutoff = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local offset = tonumber(ARGV[3])
local tags
if offset == 0 then
  tags = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', '(' .. ARGV[1], 'LIMIT', 0, limit)
else
  -- Rank-based paging avoids ZRANGEBYSCORE's O(offset) scan over permanent barriers.
  local page = redis.call('ZRANGE', KEYS[2], offset, offset + limit - 1, 'WITHSCORES')
  tags = {}
  for i = 1, #page, 2 do
    if tonumber(page[i + 1]) >= cutoff then break end
    tags[#tags + 1] = page[i]
  end
end
local removed = 0
for _, tag in ipairs(tags) do
  if tag ~= '__cch_flush__' and string.sub(tag, 1, 14) ~= '__cch_flush__:' then
    local current = redis.call('HGET', KEYS[1], tag)
    local safe = not current
    if current then
      local comma = string.find(current, ',', 1, true)
      local s, e
      if comma then
        s = string.sub(current, 1, comma - 1)
        e = string.sub(current, comma + 1)
      else
        s, e = current, ''
      end
      local sn, en = tonumber(s), tonumber(e)
      if (s == '' or sn) and (e == '' or en) then
        safe = math.max(sn or 0, en or 0) < cutoff
      end
    end
    if safe then
      redis.call('HDEL', KEYS[1], tag)
      redis.call('ZREM', KEYS[2], tag)
      removed = removed + 1
    end
  end
end
local nextOffset = 0
if #tags == limit then nextOffset = offset + #tags - removed end
return {removed, nextOffset, redis.call('HLEN', KEYS[1]), redis.call('ZCARD', KEYS[2])}`;

/** A script may discover an ACL restriction or a failover to an older server after the probe. */
export function disableTagFieldExpiry(connection: RedisConnection): void {
  const state = capability(connection);
  state.supported = false;
  state.attempt = false;
  state.scriptRejected = true;
}

/** Unknown support uses the guarded write script so startup HSETs cannot clear native TTLs. */
export function shouldExpireTagFields(connection: RedisConnection): boolean {
  return capability(connection).attempt;
}

/** Retry a transient probe failure once on the next ready event, never on every request/tick. */
export function retryTagFieldProbeOnReady(connection: RedisConnection): void {
  const state = capability(connection);
  if (state.retryOnReady && !state.scriptRejected) {
    state.probing = undefined;
    state.retryOnReady = false;
  }
}

/** SHA1 of the standalone maintenance script, verified in unit tests. */
export const PRUNE_TAGS_SHA = "ea6498fcdcf2a8bc621ae85b511de7c4735735d3";
