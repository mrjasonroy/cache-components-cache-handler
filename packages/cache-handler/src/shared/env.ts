/**
 * Runtime settings from the environment.
 *
 * Next loads cache handler files by path and cannot hand them objects from `next.config`, and a
 * standalone `server.js` never runs `next.config` at all. So the handlers `withCache` points Next
 * at read everything from the environment, the same under `next start`, standalone and Docker:
 *
 * | Variable | Meaning |
 * |---|---|
 * | `REDIS_URL` / `VALKEY_URL` | `redis://` or `rediss://` URL. Unset → memory only. |
 * | `ELASTICACHE_ENDPOINT`, `ELASTICACHE_PORT`, `ELASTICACHE_AUTH_TOKEN`, `ELASTICACHE_TLS` | Host form, TLS on unless `ELASTICACHE_TLS=false`. |
 * | `REDIS_PASSWORD` | Password when the URL has none. |
 * | `CACHE_KEY_PREFIX` | Prefix for every key. Default `nextjs:`. |
 * | `CACHE_REDIS=off` | Kill switch: memory everywhere, even with a URL set. |
 * | `CACHE_DEBUG=1` | Log hits, misses and state changes. Never the URL. |
 *
 * During `next build` (`NEXT_PHASE=phase-production-build`, set by `next build` before it starts
 * the static-generation workers, next/dist/build/index.js) the handlers use memory and never
 * connect.
 */

import type { RedisConnectionOptions } from "./connection.js";

/**
 * `NEXT_PHASE` during `next build` (`PHASE_PRODUCTION_BUILD` in next/dist/shared/lib/constants).
 */
export const PHASE_PRODUCTION_BUILD = "phase-production-build";

/**
 * Default prefix for every key.
 */
export const DEFAULT_KEY_PREFIX = "nextjs:";

/**
 * True inside `next build`.
 */
export function isBuildPhase(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NEXT_PHASE === PHASE_PRODUCTION_BUILD;
}

/**
 * True when `CACHE_REDIS=off` (also `0`, `false`, `no`): use memory everywhere.
 */
export function isRedisDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.CACHE_REDIS?.trim().toLowerCase();
  return value === "off" || value === "0" || value === "false" || value === "no";
}

/**
 * True when `CACHE_DEBUG=1` (also `true`).
 */
export function isDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.CACHE_DEBUG?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * `CACHE_KEY_PREFIX`, or `nextjs:`.
 */
export function resolveKeyPrefix(env: NodeJS.ProcessEnv = process.env): string {
  return env.CACHE_KEY_PREFIX || DEFAULT_KEY_PREFIX;
}

/**
 * Connection settings, from the options first and then the environment.
 */
export interface ConnectionSettings {
  /** `redis`/`valkey` read a URL; `elasticache` reads a host. */
  type?: "redis" | "valkey" | "elasticache";
  url?: string;
  endpoint?: string;
  port?: number;
  tls?: boolean;
  password?: string;
  commandTimeout?: number;
  initialConnectWaitMs?: number;
  errorLogIntervalMs?: number;
}

function optional<K extends keyof RedisConnectionOptions>(
  key: K,
  value: RedisConnectionOptions[K] | undefined,
): Partial<RedisConnectionOptions> {
  return value === undefined ? {} : { [key]: value };
}

function elasticacheOptions(
  settings: ConnectionSettings,
  endpoint: string,
  env: NodeJS.ProcessEnv,
): RedisConnectionOptions {
  const port =
    settings.port || (env.ELASTICACHE_PORT ? Number.parseInt(env.ELASTICACHE_PORT, 10) : 6379);
  const password = settings.password || env.ELASTICACHE_AUTH_TOKEN || env.REDIS_PASSWORD;
  return {
    host: endpoint,
    port,
    tls: settings.tls ?? env.ELASTICACHE_TLS !== "false",
    connectTimeout: 10000,
    ...optional("password", password || undefined),
  };
}

/**
 * Resolve connection options for an explicit backend `type`, as `createCacheHandler` does: a
 * `redis`/`valkey` type without a URL falls back to `redis://localhost:6379`, and `elasticache`
 * without an endpoint throws.
 */
export function resolveConnectionOptions(
  settings: ConnectionSettings & { type: "redis" | "valkey" | "elasticache" },
  env: NodeJS.ProcessEnv = process.env,
): RedisConnectionOptions {
  const common: RedisConnectionOptions = {
    ...optional("commandTimeout", settings.commandTimeout),
    ...optional("initialConnectWaitMs", settings.initialConnectWaitMs),
    ...optional("errorLogIntervalMs", settings.errorLogIntervalMs),
  };

  if (settings.type === "elasticache") {
    const endpoint = settings.endpoint || env.ELASTICACHE_ENDPOINT;
    if (!endpoint) {
      throw new Error(
        "ElastiCache endpoint is required. Set ELASTICACHE_ENDPOINT environment variable or pass 'endpoint' option.",
      );
    }
    return { ...common, ...elasticacheOptions(settings, endpoint, env) };
  }

  const password = settings.password ?? env.REDIS_PASSWORD;
  return {
    ...common,
    url: settings.url || env.REDIS_URL || env.VALKEY_URL || "redis://localhost:6379",
    tls: settings.tls ?? false,
    ...optional("password", password || undefined),
  };
}

/**
 * Resolve connection options with no backend type: a URL (option, `REDIS_URL`, `VALKEY_URL`),
 * else an ElastiCache endpoint (option, `ELASTICACHE_ENDPOINT`), else `undefined` (memory only).
 * Does not look at `CACHE_REDIS` or the build phase; see {@link shouldUseRedis}.
 */
export function resolveEnvConnectionOptions(
  settings: ConnectionSettings = {},
  env: NodeJS.ProcessEnv = process.env,
): RedisConnectionOptions | undefined {
  const url = settings.url || env.REDIS_URL || env.VALKEY_URL;
  if (url) return resolveConnectionOptions({ ...settings, type: "redis", url }, env);

  const endpoint = settings.endpoint || env.ELASTICACHE_ENDPOINT;
  if (endpoint)
    return resolveConnectionOptions({ ...settings, type: "elasticache", endpoint }, env);

  return undefined;
}

/**
 * False inside `next build` and with `CACHE_REDIS=off`: Redis must not be used, even when it is
 * configured.
 */
export function shouldUseRedis(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isBuildPhase(env) && !isRedisDisabled(env);
}
