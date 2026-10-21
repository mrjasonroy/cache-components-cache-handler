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
 * | `ELASTICACHE_IAM_USER` | IAM authentication as this user id (host form or a `rediss://` URL), with `ELASTICACHE_CACHE_NAME`, `ELASTICACHE_REGION` (else `AWS_REGION`, `AWS_DEFAULT_REGION`) and `ELASTICACHE_SERVERLESS` (else detected from a `.serverless.` hostname). |
 * | `REDIS_PASSWORD` | Password when the URL has none. |
 * | `CACHE_KEY_PREFIX` | Prefix for every key. Default `nextjs:`. |
 * | `CACHE_REDIS=off` | Kill switch: memory everywhere, even with a URL set. |
 * | `CACHE_DEBUG=1` | Log hits, misses and state changes. Never the URL. |
 * | `CACHE_COMPRESSION=off` | Store entries uncompressed (v2). Default: Brotli for entries of 16 KB and more. |
 *
 * During `next build` (`NEXT_PHASE=phase-production-build`, set by `next build` before it starts
 * the static-generation workers, next/dist/build/index.js) the handlers use memory and never
 * connect.
 */

import type { RedisConnectionOptions } from "./connection.js";
import type { ElastiCacheIamOptions, ResolvedIamOptions } from "./elasticache-iam.js";

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
 * True on Next's edge runtime (`NEXT_RUNTIME=edge`), where Next can load the page handler as part
 * of the middleware bundle. There is no Node there to reach Redis or the disk with, so the
 * handlers are no-ops: every read is a miss and writes and revalidations do nothing.
 */
export function isEdgeRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NEXT_RUNTIME === "edge";
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
 * False when `CACHE_COMPRESSION=off` (also `0`, `false`, `no`): entries are stored uncompressed.
 */
export function isCompressionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.CACHE_COMPRESSION?.trim().toLowerCase();
  return !(value === "off" || value === "0" || value === "false" || value === "no");
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
  connectTimeout?: number;
  socketTimeout?: number;
  maxConsecutiveTimeouts?: number;
  initialConnectWaitMs?: number;
  errorLogIntervalMs?: number;
  /** ElastiCache IAM authentication; also turned on by `ELASTICACHE_IAM_USER`. */
  iam?: ElastiCacheIamOptions;
}

function optional<K extends keyof RedisConnectionOptions>(
  key: K,
  value: RedisConnectionOptions[K] | undefined,
): Partial<RedisConnectionOptions> {
  return value === undefined ? {} : { [key]: value };
}

/** `true`/`false` from `1`, `true`, `yes` / `0`, `false`, `no`; anything else is `undefined`. */
function parseFlag(value: string | undefined): boolean | undefined {
  const flag = value?.trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") return true;
  if (flag === "0" || flag === "false" || flag === "no") return false;
  return undefined;
}

/**
 * The IAM settings for a connection to `host`, or `undefined` when IAM is off (no `iam` option
 * and no `ELASTICACHE_IAM_USER`). Throws, naming everything that is missing, when IAM is asked for
 * but cannot work: no user, cache name or region, or TLS off.
 */
export function resolveIamOptions(
  iam: ElastiCacheIamOptions | undefined,
  connection: { host: string | undefined; tls: boolean },
  env: NodeJS.ProcessEnv = process.env,
): ResolvedIamOptions | undefined {
  const envUser = env.ELASTICACHE_IAM_USER?.trim();
  if (iam === undefined && !envUser) return undefined;

  const userId = iam?.userId?.trim() || envUser;
  const cacheName = (iam?.cacheName || env.ELASTICACHE_CACHE_NAME)?.trim().toLowerCase();
  const region = (
    iam?.region ||
    env.ELASTICACHE_REGION ||
    env.AWS_REGION ||
    env.AWS_DEFAULT_REGION
  )?.trim();
  const problems: string[] = [];
  if (!userId) problems.push("no user: set ELASTICACHE_IAM_USER (or iam.userId)");
  if (!cacheName) {
    problems.push(
      "no cache name: set ELASTICACHE_CACHE_NAME (or iam.cacheName) to the replication group id or serverless cache name",
    );
  }
  if (!region) {
    problems.push("no region: set ELASTICACHE_REGION or AWS_REGION (or iam.region)");
  }
  if (!connection.tls) {
    problems.push(
      "TLS is off, and IAM authentication needs it: use a rediss:// URL, or leave ELASTICACHE_TLS unset",
    );
  }
  if (!userId || !cacheName || !region || problems.length > 0) {
    throw new Error(`ElastiCache IAM authentication cannot work: ${problems.join("; ")}.`);
  }
  const serverless =
    iam?.serverless ??
    parseFlag(env.ELASTICACHE_SERVERLESS) ??
    connection.host?.toLowerCase().includes(".serverless.") === true;
  return {
    userId,
    cacheName,
    region,
    serverless,
    ...(iam?.credentials ? { credentials: iam.credentials } : {}),
  };
}

/** The hostname of a Redis URL, if it parses. */
function urlHost(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function elasticacheOptions(
  settings: ConnectionSettings,
  endpoint: string,
  env: NodeJS.ProcessEnv,
): RedisConnectionOptions {
  const port =
    settings.port || (env.ELASTICACHE_PORT ? Number.parseInt(env.ELASTICACHE_PORT, 10) : 6379);
  const tls = settings.tls ?? env.ELASTICACHE_TLS !== "false";
  const iam = resolveIamOptions(settings.iam, { host: endpoint, tls }, env);
  // An IAM token replaces any password.
  const password = iam
    ? undefined
    : settings.password || env.ELASTICACHE_AUTH_TOKEN || env.REDIS_PASSWORD;
  return {
    host: endpoint,
    port,
    tls,
    connectTimeout: settings.connectTimeout ?? 10000,
    ...optional("password", password || undefined),
    ...optional("iam", iam),
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
    ...optional("connectTimeout", settings.connectTimeout),
    ...optional("socketTimeout", settings.socketTimeout),
    ...optional("maxConsecutiveTimeouts", settings.maxConsecutiveTimeouts),
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

  const url = settings.url || env.REDIS_URL || env.VALKEY_URL || "redis://localhost:6379";
  const tls = settings.tls ?? false;
  const iam = resolveIamOptions(
    settings.iam,
    { host: urlHost(url), tls: tls || url.toLowerCase().startsWith("rediss://") },
    env,
  );
  const password = iam ? undefined : (settings.password ?? env.REDIS_PASSWORD);
  return {
    ...common,
    url,
    tls,
    ...optional("password", password || undefined),
    ...optional("iam", iam),
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
 * False inside `next build`, on the edge runtime and with `CACHE_REDIS=off`: Redis must not be
 * used, even when it is configured.
 */
export function shouldUseRedis(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isBuildPhase(env) && !isEdgeRuntime(env) && !isRedisDisabled(env);
}
