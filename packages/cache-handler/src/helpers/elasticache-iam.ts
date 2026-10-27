/**
 * ElastiCache IAM authentication for a client the application builds itself (a `Cluster` for
 * cluster-mode-enabled ElastiCache, or any other ioredis setup the environment cannot describe).
 * The package's own connections get it from `ELASTICACHE_IAM_USER` or the `iam` option instead.
 */

import type { Cluster, Redis } from "ioredis";
import { type ElastiCacheIamOptions, attachIamAuth } from "../shared/elasticache-iam.js";
import { resolveIamOptions } from "../shared/env.js";
import { type CacheLogger, loggerSource } from "../shared/logger.js";

/**
 * Options of {@link attachElastiCacheIamAuth}.
 */
export interface AttachElastiCacheIamAuthOptions extends ElastiCacheIamOptions {
  /**
   * Where token and authentication errors go.
   * @default the logger set with `setCacheLogger`, else the console
   */
  logger?: CacheLogger;
}

/**
 * The IAM authentication attached to a client.
 */
export interface ElastiCacheIamAuth {
  /**
   * Mint a new token and re-authenticate every live connection now. Resolves `false` if the token
   * could not be made (the error is logged).
   */
  refresh(): Promise<boolean>;
  /** Stop refreshing. The client keeps its last token and its connections. */
  stop(): void;
}

/** The host of a `Cluster` startup node: a `{ host }`, a `host:port` or a URL. */
function startupHost(node: unknown): string | undefined {
  if (typeof node === "string") return node;
  if (typeof node === "object" && node !== null) {
    const host = (node as { host?: unknown }).host;
    return typeof host === "string" ? host : undefined;
  }
  return undefined;
}

/**
 * Keep your own ioredis `Redis` or `Cluster` authenticated to ElastiCache with IAM: a fresh token
 * (valid 15 minutes) in the client's options for every reconnect, refreshed every 10 minutes, and
 * a standalone `AUTH` on every live connection (every node of a `Cluster`) so ElastiCache does not
 * close it after 12 hours. Rejected credentials are logged as errors naming IAM.
 *
 * Create the client with `lazyConnect: true` and TLS, and do not call `connect()`: it is
 * connected once the first token is ready. Settings missing here come from the environment, as
 * for the package's own connections. Throws if IAM cannot work (no user, cache name or region, TLS
 * off) or the AWS packages are not installed.
 *
 * @example
 * ```js
 * // cache/redis.mjs: pass `client` to every custom handler file
 * import { Cluster } from "ioredis";
 * import { attachElastiCacheIamAuth } from "@mrjasonroy/cache-components-cache-handler";
 *
 * function createClient() {
 *   const client = new Cluster(
 *     [{ host: "clustercfg.my-cache.abc123.use1.cache.amazonaws.com", port: 6379 }],
 *     {
 *       lazyConnect: true,
 *       dnsLookup: (address, callback) => callback(null, address), // keep hostnames for TLS
 *       redisOptions: { tls: {}, commandTimeout: 1000 },
 *     },
 *   );
 *   attachElastiCacheIamAuth(client, { userId: "app-user", cacheName: "my-cache", region: "us-east-1" });
 *   return client;
 * }
 *
 * // One client per process: Next can load each handler file in its own module graph.
 * export const client = (globalThis.myAppRedis ??= createClient());
 * ```
 */
export function attachElastiCacheIamAuth(
  client: Redis | Cluster,
  options: AttachElastiCacheIamAuthOptions = {},
): ElastiCacheIamAuth {
  const { logger, ...iam } = options;
  const cluster = (client as { isCluster?: boolean }).isCluster === true;
  const tls = cluster
    ? Boolean((client as Cluster).options.redisOptions?.tls)
    : Boolean((client as Redis).options.tls);
  // A Cluster's first startup node (ioredis keeps them, untyped): enough to spot `.serverless.`.
  const host = cluster
    ? startupHost((client as unknown as { startupNodes?: unknown[] }).startupNodes?.[0])
    : (client as Redis).options.host;
  const resolved = resolveIamOptions(iam, { host, tls });
  if (!resolved) throw new Error("ElastiCache IAM authentication needs a user id");
  return attachIamAuth(client, resolved, { logger: loggerSource(logger), connect: true });
}
