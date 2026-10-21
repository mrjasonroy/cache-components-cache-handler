/**
 * AWS ElastiCache IAM authentication for the ioredis clients: a short-lived token as the password,
 * kept fresh for every reconnect, and a re-`AUTH` of every live connection before ElastiCache
 * drops it.
 *
 * What ElastiCache asks (https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/auth-iam.html):
 * - the password is a SigV4-presigned `GET http://{cacheName}/?Action=connect&User={userId}`
 *   (`&ResourceType=ServerlessCache` for a serverless cache), service `elasticache`, valid for
 *   15 minutes, without its `http://`; the user name is the user id;
 * - a connection that authenticated with a token is closed after 12 hours, unless it sends a new
 *   `AUTH` (or `HELLO`) with a fresh token, which extends it another 12 hours;
 * - TLS on, Valkey 7.2+ or Redis OSS 7.0+, and no `AUTH` inside `MULTI`/`EXEC` or a script.
 *
 * So a token generated once and passed as `password` works for 15 minutes: every reconnect after
 * that is rejected, ioredis retries forever with the dead token, and the handlers quietly serve
 * from memory. Instead, {@link attachIamAuth}:
 * - mints a token every `refreshIntervalMs` (10 minutes) on an unref'd timer, writes it into the
 *   client's options (for a `Cluster`, its `redisOptions` and every node's options), which ioredis
 *   reads on each (re)connect, and sends a standalone `AUTH user token` on every ready connection
 *   (every node of a `Cluster`), which keeps the 12-hour window moving;
 * - wraps `connect`, so a (re)connect never starts with a token older than `refreshIntervalMs`: it
 *   mints one first if the timer has fallen behind (a suspended process);
 * - logs a rejected authentication as an error naming IAM as the likely cause, and token failures
 *   (no credentials, a signing error) as errors too, rate-limited, and tries again on the next
 *   tick or reconnect. Nothing here throws into a cache call.
 *
 * The AWS packages (`@smithy/signature-v4`, `@aws-crypto/sha256-js`,
 * `@aws-sdk/credential-provider-node`) are optional and loaded on first use, like ioredis: a
 * process that does not use IAM never loads them, and one that does without them installed fails
 * at startup with what to install. The token is never logged; the logger also scrubs the
 * presigned query parameters from any text, in case one reaches an error message.
 */

import type { Cluster, Redis, RedisOptions } from "ioredis";
import { nowMs } from "./clock.js";
import { DEFAULT_ERROR_LOG_INTERVAL_MS, createErrorReporter } from "./error-reporter.js";
import { type LoggerSource, processLogger } from "./logger.js";
import { requireModule } from "./node-require.js";

/** How long a token is valid, in seconds: the most ElastiCache accepts. */
export const IAM_TOKEN_EXPIRES_IN_SECONDS = 900;

/** How often a new token is minted and every live connection re-authenticated, in ms. */
export const DEFAULT_IAM_REFRESH_INTERVAL_MS = 10 * 60_000;

/**
 * AWS credentials, as the AWS SDK's credential providers return them.
 */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

/**
 * A function returning AWS credentials, such as the AWS SDK's `fromNodeProviderChain()` or
 * `fromTemporaryCredentials()`. Called for every token, so it should cache (the SDK's do).
 */
export type AwsCredentialsProvider = () => Promise<AwsCredentials>;

/**
 * ElastiCache IAM authentication settings. Every field falls back to the environment.
 */
export interface ElastiCacheIamOptions {
  /**
   * The IAM-enabled ElastiCache user's id, which ElastiCache requires to equal its user name.
   * @default process.env.ELASTICACHE_IAM_USER
   */
  userId?: string;

  /**
   * The replication group id (node-based cache) or serverless cache name the token is for.
   * Lowercased, as ElastiCache stores it.
   * @default process.env.ELASTICACHE_CACHE_NAME
   */
  cacheName?: string;

  /**
   * The cache's AWS region.
   * @default process.env.ELASTICACHE_REGION ?? AWS_REGION ?? AWS_DEFAULT_REGION
   */
  region?: string;

  /**
   * True for an ElastiCache Serverless cache.
   * @default ELASTICACHE_SERVERLESS, else whether the endpoint's hostname contains `.serverless.`
   */
  serverless?: boolean;

  /**
   * Where the AWS credentials come from.
   * @default the AWS SDK's default chain (env, SSO, web identity, ECS/EKS, EC2 instance metadata)
   */
  credentials?: AwsCredentialsProvider;
}

/**
 * IAM settings with nothing left to resolve.
 */
export interface ResolvedIamOptions {
  userId: string;
  cacheName: string;
  region: string;
  serverless: boolean;
  credentials?: AwsCredentialsProvider;
}

/** Makes one token; the AWS packages behind it are already loaded. */
export type IamTokenSigner = () => Promise<string>;

interface PresignableRequest {
  method: string;
  protocol: string;
  hostname: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
}

interface SignatureV4Like {
  presign(
    request: PresignableRequest,
    options: { expiresIn: number; signingDate: number },
  ): Promise<{ query?: Record<string, string | string[] | null> }>;
}

interface AwsModules {
  SignatureV4: new (init: {
    service: string;
    region: string;
    credentials: AwsCredentialsProvider;
    sha256: unknown;
    uriEscapePath?: boolean;
  }) => SignatureV4Like;
  Sha256: unknown;
  defaultProvider(): AwsCredentialsProvider;
}

const AWS_PACKAGES = [
  "@smithy/signature-v4",
  "@aws-crypto/sha256-js",
  "@aws-sdk/credential-provider-node",
] as const;

/**
 * The AWS packages that sign a token, loaded on first use. Throws with what to install when one
 * is missing.
 */
function loadAwsModules(): AwsModules {
  const missing: string[] = [];
  const load = <T>(id: (typeof AWS_PACKAGES)[number]): T | undefined => {
    try {
      return requireModule<T>(id);
    } catch {
      missing.push(id);
      return undefined;
    }
  };
  const signature = load<Pick<AwsModules, "SignatureV4">>("@smithy/signature-v4");
  const sha = load<Pick<AwsModules, "Sha256">>("@aws-crypto/sha256-js");
  const provider = load<Pick<AwsModules, "defaultProvider">>("@aws-sdk/credential-provider-node");
  if (!signature || !sha || !provider) {
    throw new Error(
      `ElastiCache IAM authentication needs ${missing.join(", ")}. Install them with: npm install ${AWS_PACKAGES.join(" ")}`,
    );
  }
  return {
    SignatureV4: signature.SignatureV4,
    Sha256: sha.Sha256,
    defaultProvider: provider.defaultProvider,
  };
}

/** RFC 3986 escaping, as SigV4 canonicalizes the query. */
function escapeUri(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * A signer for `options`, loading the AWS packages now: throws at once if they are missing.
 * `now` is the signing time, for tests.
 */
export function createIamTokenSigner(
  options: ResolvedIamOptions,
  now: () => number = nowMs,
): IamTokenSigner {
  const aws = loadAwsModules();
  const signer = new aws.SignatureV4({
    service: "elasticache",
    region: options.region,
    credentials: options.credentials ?? aws.defaultProvider(),
    sha256: aws.Sha256,
  });
  const query: Record<string, string> = { Action: "connect", User: options.userId };
  if (options.serverless) query.ResourceType = "ServerlessCache";

  return async () => {
    const signed = await signer.presign(
      {
        method: "GET",
        protocol: "http:",
        hostname: options.cacheName,
        path: "/",
        query: { ...query },
        headers: { host: options.cacheName },
      },
      // Epoch seconds, which the signer turns into its date: no `Date` read here (see clock.ts).
      { expiresIn: IAM_TOKEN_EXPIRES_IN_SECONDS, signingDate: Math.floor(now() / 1000) },
    );
    const parameters = Object.entries(signed.query ?? {}).flatMap(([key, value]) =>
      (Array.isArray(value) ? value : [value]).map((item) =>
        item === null ? escapeUri(key) : `${escapeUri(key)}=${escapeUri(item)}`,
      ),
    );
    return `${options.cacheName}/?${parameters.join("&")}`;
  };
}

/** A `Cluster`'s internals the token must reach: the pool that opens node connections. */
interface ClusterInternals {
  connectionPool?: { redisOptions?: RedisOptions };
}

function isCluster(client: Redis | Cluster): client is Cluster {
  return (client as { isCluster?: boolean }).isCluster === true;
}

/**
 * Put the credentials where ioredis reads them on its next (re)connect: a `Redis`'s options, or a
 * `Cluster`'s `redisOptions` (which new node connections copy) and each node's own options.
 */
function applyCredentials(client: Redis | Cluster, username: string, password: string): void {
  if (!isCluster(client)) {
    client.options.username = username;
    client.options.password = password;
    return;
  }
  client.options.redisOptions ??= {};
  client.options.redisOptions.username = username;
  client.options.redisOptions.password = password;
  // The pool was given the cluster's `redisOptions` object at construction; a cluster created
  // without one holds `undefined`, so hand it the object just created.
  const pool = (client as unknown as ClusterInternals).connectionPool;
  if (pool && pool.redisOptions !== client.options.redisOptions) {
    pool.redisOptions = client.options.redisOptions;
  }
  for (const node of client.nodes("all")) {
    node.options.username = username;
    node.options.password = password;
  }
}

/** The connections that are authenticated now: the client, or every ready node of a `Cluster`. */
function liveConnections(client: Redis | Cluster): Redis[] {
  const connections = isCluster(client) ? client.nodes("all") : [client];
  return connections.filter((connection) => connection.status === "ready");
}

const AUTH_ERROR = /WRONGPASS|NOAUTH|NOPERM|invalid username-password|authentication required/i;

/** True for an error that says the server refused the credentials. */
export function isAuthError(error: unknown): boolean {
  return error instanceof Error && AUTH_ERROR.test(error.message);
}

function iamHint(options: ResolvedIamOptions): string {
  return `check that "${options.userId}" is an IAM-enabled ElastiCache user (user id equal to user name) in the cache's user group, that the IAM identity's policy allows elasticache:Connect on both the cache "${options.cacheName}" and the user, and that the cache name (${options.cacheName}), region (${options.region}) and serverless setting (${options.serverless}) match the cache`;
}

/**
 * A client's IAM authentication, attached by {@link attachIamAuth}.
 */
export interface IamAuth {
  /**
   * Mint a token now, put it in the client's options and re-authenticate every live connection.
   * Resolves `true` once the token is in place, `false` if it could not be made (logged). Calls
   * made while one runs share it.
   */
  refresh(): Promise<boolean>;
  /**
   * Stop the timer, stop minting tokens and unwrap `connect`. The client keeps its last token
   * and its connections.
   */
  stop(): void;
}

export interface AttachIamAuthOptions {
  logger?: LoggerSource;
  errorLogIntervalMs?: number;
  refreshIntervalMs?: number;
  /** Makes the tokens; {@link createIamTokenSigner} by default. */
  signer?: IamTokenSigner;
  /** Connect a client still waiting to (`lazyConnect`) once its first token is in place. */
  connect?: boolean;
}

/**
 * Keep `client` authenticated to ElastiCache with IAM tokens (see the module comment). Loads the
 * AWS packages now, so a missing one throws here. The client should be created with
 * `lazyConnect: true`: it is connected once the first token is ready, and a command sent before
 * that fails as it would while disconnected.
 */
export function attachIamAuth(
  client: Redis | Cluster,
  iam: ResolvedIamOptions,
  options: AttachIamAuthOptions = {},
): IamAuth {
  const signer = options.signer ?? createIamTokenSigner(iam);
  const intervalMs = options.refreshIntervalMs ?? DEFAULT_IAM_REFRESH_INTERVAL_MS;
  const report = createErrorReporter(
    "[RedisCache]:",
    options.errorLogIntervalMs ?? DEFAULT_ERROR_LOG_INTERVAL_MS,
    options.logger ?? processLogger,
  );
  const hint = iamHint(iam);
  let mintedAt: number | undefined;
  let pending: Promise<boolean> | undefined;
  let stopped = false;

  const reauthenticate = async (token: string) => {
    await Promise.all(
      liveConnections(client).map((connection) =>
        connection.auth(iam.userId, token).then(
          () => undefined,
          (error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error);
            report(
              "ElastiCache IAM re-authentication",
              new Error(`a live connection refused a new IAM token (${reason}): ${hint}`),
            );
          },
        ),
      ),
    );
  };

  const mint = async (): Promise<boolean> => {
    let token: string;
    try {
      token = await signer();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      report(
        "ElastiCache IAM token",
        new Error(
          `could not make an IAM auth token (${reason}); check the AWS credentials available to this process and the region, retrying on the next reconnect or refresh`,
        ),
      );
      return false;
    }
    if (stopped) return false;
    mintedAt = nowMs();
    applyCredentials(client, iam.userId, token);
    await reauthenticate(token);
    return true;
  };

  const refresh = (): Promise<boolean> => {
    if (pending) return pending;
    const run = mint().finally(() => {
      if (pending === run) pending = undefined;
    });
    pending = run;
    return run;
  };

  const fresh = () => mintedAt !== undefined && nowMs() - mintedAt < intervalMs;

  // Every (re)connect, ioredis's own retries included, goes through `connect`: make sure it reads
  // a fresh token. If none can be made it connects anyway, the server refuses it, and the
  // reconnect backoff paces the next attempt.
  const ownConnect = Object.getOwnPropertyDescriptor(client, "connect");
  const connect = client.connect.bind(client) as (...args: unknown[]) => Promise<void>;
  const freshConnect = (async (...args: unknown[]) => {
    const status = client.status;
    if (!stopped && !fresh()) await refresh();
    // Closed, or connected by another call, while the token was being made.
    if (client.status !== status) {
      throw new Error("Connection closed or connecting while the IAM token was made");
    }
    return connect(...args);
  }) as typeof client.connect;
  client.connect = freshConnect;

  const onError = (error: unknown) => {
    if (!isAuthError(error)) return;
    const reason = error instanceof Error ? error.message : String(error);
    report(
      "ElastiCache IAM authentication",
      new Error(`the server refused the IAM credentials (${reason}): ${hint}`),
    );
  };
  client.on("error", onError);

  const timer = setInterval(() => {
    void refresh();
  }, intervalMs);
  timer.unref?.();

  if (options.connect && client.status === "wait") client.connect().catch(() => {});
  else void refresh();

  return {
    refresh,
    stop() {
      stopped = true;
      clearInterval(timer);
      client.off("error", onError);
      // Back to the `connect` it had, unless someone has replaced it since.
      if (client.connect !== freshConnect) return;
      if (ownConnect) Object.defineProperty(client, "connect", ownConnect);
      else Reflect.deleteProperty(client, "connect");
    },
  };
}
