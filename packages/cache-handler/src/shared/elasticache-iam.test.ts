import { createHash, createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Cluster, Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type AwsCredentials,
  DEFAULT_IAM_REFRESH_INTERVAL_MS,
  DEFAULT_IAM_TOKEN_TIMEOUT_MS,
  type ResolvedIamOptions,
  attachIamAuth,
  createIamTokenSigner,
  isAuthError,
} from "./elasticache-iam.js";
import { type CacheLogger, setCacheLogger, writeLog } from "./logger.js";

const CREDENTIALS: AwsCredentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  sessionToken: "session/token+with=chars",
};
const SIGNING_TIME = Date.parse("2026-01-02T03:04:05Z");

const NODE_BASED: ResolvedIamOptions = {
  userId: "app-user",
  cacheName: "my-cache",
  region: "us-east-1",
  serverless: false,
  credentials: async () => CREDENTIALS,
};

/** RFC 3986, as SigV4 wants it. */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The token, computed from the SigV4 specification with node:crypto alone
 * (https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html), to check the
 * signer against something that does not share its code.
 */
function referenceToken(options: ResolvedIamOptions, credentials: AwsCredentials, time: number) {
  const amzDate = new Date(time)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${options.region}/elasticache/aws4_request`;
  const query: Record<string, string> = {
    Action: "connect",
    User: options.userId,
    ...(options.serverless ? { ResourceType: "ServerlessCache" } : {}),
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${credentials.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": "900",
    ...(credentials.sessionToken ? { "X-Amz-Security-Token": credentials.sessionToken } : {}),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((key) => `${rfc3986(key)}=${rfc3986(query[key] ?? "")}`)
    .join("&");
  const emptyHash = createHash("sha256").update("").digest("hex");
  const canonicalRequest = [
    "GET",
    "/",
    canonicalQuery,
    `host:${options.cacheName}\n`,
    "host",
    emptyHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const hmac = (key: string | Buffer, data: string) =>
    createHmac("sha256", key).update(data).digest();
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), options.region), "elasticache"),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return { query, signature };
}

function parseToken(token: string) {
  const [host, search = ""] = token.split("/?");
  return { host, params: new URLSearchParams(search), search };
}

describe("createIamTokenSigner", () => {
  test("signs a node-based token exactly as SigV4 specifies", async () => {
    const token = await createIamTokenSigner(NODE_BASED, () => SIGNING_TIME)();
    const { host, params, search } = parseToken(token);
    const reference = referenceToken(NODE_BASED, CREDENTIALS, SIGNING_TIME);

    expect(token.startsWith("my-cache/?Action=connect&User=app-user&")).toBe(true);
    expect(token).not.toMatch(/^https?:/);
    expect(host).toBe("my-cache");
    expect(params.has("ResourceType")).toBe(false);
    for (const [key, value] of Object.entries(reference.query)) {
      expect(params.get(key)).toBe(value);
    }
    expect(params.get("X-Amz-Signature")).toBe(reference.signature);
    // Encoded as SigV4 canonicalizes it: `/` in the credential, `+` and `=` in the session token.
    expect(search).toContain("X-Amz-Credential=AKIDEXAMPLE%2F20260102%2Fus-east-1%2F");
    expect(search).toContain("X-Amz-Security-Token=session%2Ftoken%2Bwith%3Dchars");
  });

  test("adds ResourceType=ServerlessCache for a serverless cache", async () => {
    const serverless = { ...NODE_BASED, serverless: true };
    const token = await createIamTokenSigner(serverless, () => SIGNING_TIME)();
    const { params } = parseToken(token);

    expect(
      token.startsWith("my-cache/?Action=connect&User=app-user&ResourceType=ServerlessCache&"),
    ).toBe(true);
    expect(params.get("X-Amz-Signature")).toBe(
      referenceToken(serverless, CREDENTIALS, SIGNING_TIME).signature,
    );
  });

  test("signs without a session token for long-term credentials", async () => {
    const credentials = { accessKeyId: "AKID", secretAccessKey: "secret" };
    const options = { ...NODE_BASED, credentials: async () => credentials };
    const { params } = parseToken(await createIamTokenSigner(options, () => SIGNING_TIME)());

    expect(params.has("X-Amz-Security-Token")).toBe(false);
    expect(params.get("X-Amz-Signature")).toBe(
      referenceToken(options, credentials, SIGNING_TIME).signature,
    );
  });

  test("a credentials failure rejects the token", async () => {
    const options = {
      ...NODE_BASED,
      credentials: async (): Promise<AwsCredentials> => {
        throw new Error("Could not load credentials from any providers");
      },
    };
    await expect(createIamTokenSigner(options)()).rejects.toThrow(/Could not load credentials/);
  });
});

/** Enough of an ioredis `Redis` for the IAM auth: status, options, `connect`, `auth`, events. */
class FakeConnection extends EventEmitter {
  readonly isCluster = false;
  status = "wait";
  options: { username?: string; password?: string } = {};
  /** The credentials each real connect started with. */
  readonly connects: Array<{ username?: string; password?: string }> = [];
  auth = vi.fn(async (_username: string, _password: string) => "OK");
  connect = vi.fn(async () => {
    this.connects.push({ ...this.options });
    this.status = "ready";
  });

  /** Lose the connection: ioredis then calls `connect` again. */
  drop(): void {
    this.status = "reconnecting";
  }
}

class FakeCluster extends EventEmitter {
  readonly isCluster = true;
  status = "wait";
  options: { redisOptions?: { username?: string; password?: string } } = {};
  connectionPool: { redisOptions?: { username?: string; password?: string } } = {};
  connect = vi.fn(async () => {
    this.status = "ready";
  });
  constructor(readonly nodeList: FakeConnection[]) {
    super();
  }
  nodes() {
    return this.nodeList;
  }
}

function asRedis(client: FakeConnection): Redis {
  return client as unknown as Redis;
}

/** A signer handing out `token-1`, `token-2`, ... */
function countingSigner() {
  let count = 0;
  return vi.fn(async () => `my-cache/?Action=connect&User=app-user&X-Amz-Signature=sig${++count}`);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("attachIamAuth", () => {
  let errors: string[];

  beforeEach(() => {
    errors = [];
    const logger: CacheLogger = {
      error: (message, meta) => errors.push(`${message} ${String(meta?.error)}`),
      warn: () => {},
    };
    setCacheLogger(logger);
  });

  afterEach(() => {
    setCacheLogger(undefined);
    vi.useRealTimers();
  });

  test("connects a waiting client only once its first token is in its options", async () => {
    const client = new FakeConnection();
    let release: (token: string) => void = () => {};
    const signer = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const auth = attachIamAuth(asRedis(client), NODE_BASED, { signer, connect: true });

    await settle();
    expect(client.connects).toEqual([]);
    release("first-token");
    await settle();

    expect(client.connects).toEqual([{ username: "app-user", password: "first-token" }]);
    auth.stop();
  });

  test("each refresh tick writes a new token into the options and AUTHs the live connection", async () => {
    vi.useFakeTimers();
    const client = new FakeConnection();
    const signer = countingSigner();
    const auth = attachIamAuth(asRedis(client), NODE_BASED, { signer, connect: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.status).toBe("ready");
    expect(client.auth).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEFAULT_IAM_REFRESH_INTERVAL_MS);
    expect(client.options.password).toMatch(/sig2$/);
    expect(client.auth).toHaveBeenCalledTimes(1);
    expect(client.auth).toHaveBeenLastCalledWith("app-user", client.options.password);

    await vi.advanceTimersByTimeAsync(DEFAULT_IAM_REFRESH_INTERVAL_MS);
    expect(client.auth).toHaveBeenCalledTimes(2);
    expect(client.auth).toHaveBeenLastCalledWith("app-user", expect.stringMatching(/sig3$/));
    auth.stop();
  });

  test("a reconnect never starts with a token older than the refresh interval", async () => {
    vi.useFakeTimers();
    const client = new FakeConnection();
    const signer = countingSigner();
    // A timer that never fires in time, as in a suspended process.
    const auth = attachIamAuth(asRedis(client), NODE_BASED, {
      signer,
      connect: true,
      refreshIntervalMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 120_000);

    client.drop();
    await client.connect();

    expect(client.connects.map((connect) => connect.password)).toEqual([
      expect.stringMatching(/sig1$/),
      expect.stringMatching(/sig2$/),
    ]);
    auth.stop();
  });

  test("a fresh token is reused by a reconnect", async () => {
    vi.useFakeTimers();
    const client = new FakeConnection();
    const signer = countingSigner();
    const auth = attachIamAuth(asRedis(client), NODE_BASED, { signer, connect: true });
    await vi.advanceTimersByTimeAsync(0);

    client.drop();
    await client.connect();

    expect(signer).toHaveBeenCalledTimes(1);
    expect(client.connects).toHaveLength(2);
    auth.stop();
  });

  test("a Cluster gets the token in its redisOptions, its pool and every node, and every ready node is AUTHed", async () => {
    vi.useFakeTimers();
    const ready = new FakeConnection();
    ready.status = "ready";
    const down = new FakeConnection();
    down.status = "reconnecting";
    const cluster = new FakeCluster([ready, down]);
    const realConnect = cluster.connect;
    const auth = attachIamAuth(cluster as unknown as Cluster, NODE_BASED, {
      signer: countingSigner(),
      connect: true,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(realConnect).toHaveBeenCalledTimes(1);
    expect(cluster.options.redisOptions?.password).toMatch(/sig1$/);
    expect(cluster.connectionPool.redisOptions).toBe(cluster.options.redisOptions);

    await vi.advanceTimersByTimeAsync(DEFAULT_IAM_REFRESH_INTERVAL_MS);
    for (const node of [ready, down]) {
      expect(node.options).toEqual({
        username: "app-user",
        password: expect.stringMatching(/sig2$/),
      });
    }
    expect(cluster.options.redisOptions?.password).toMatch(/sig2$/);
    expect(ready.auth).toHaveBeenCalledWith("app-user", expect.stringMatching(/sig2$/));
    expect(down.auth).not.toHaveBeenCalled();
    auth.stop();
  });

  test("stop clears the timer and unwraps connect", async () => {
    vi.useFakeTimers();
    const client = new FakeConnection();
    const original = client.connect;
    const signer = countingSigner();
    const auth = attachIamAuth(asRedis(client), NODE_BASED, { signer, connect: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    auth.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(client.connect).toBe(original);
    await vi.advanceTimersByTimeAsync(DEFAULT_IAM_REFRESH_INTERVAL_MS * 3);
    expect(signer).toHaveBeenCalledTimes(1);
  });

  test("the refresh timer does not hold the process open", () => {
    const unref = vi.fn();
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue({ unref } as unknown as NodeJS.Timeout);
    const auth = attachIamAuth(asRedis(new FakeConnection()), NODE_BASED, {
      signer: countingSigner(),
    });
    expect(unref).toHaveBeenCalled();
    auth.stop();
    setIntervalSpy.mockRestore();
  });

  test("a client closed while its token is made is not reopened", async () => {
    const client = new FakeConnection();
    let release: (token: string) => void = () => {};
    const signer = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const auth = attachIamAuth(asRedis(client), NODE_BASED, { signer, connect: true });
    auth.stop();
    client.status = "end";
    release("late-token");
    await settle();

    expect(client.connects).toEqual([]);
  });

  test("a client quit while reconnecting, as its token is made, does not open a socket", async () => {
    const client = new FakeConnection();
    client.drop();
    let release: (token: string) => void = () => {};
    const signer = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const auth = attachIamAuth(asRedis(client), NODE_BASED, { signer });
    // ioredis's reconnect timer fires: the wrapped connect waits for the token.
    const reconnect = client.connect();
    // `closeCache`: stop, then quit, which with no socket ends in `disconnect()`. The status
    // stays `reconnecting`; only `manuallyClosing` says the client is closed.
    auth.stop();
    Object.assign(client, { manuallyClosing: true });
    release("late-token");

    await expect(reconnect).rejects.toThrow(/closed/);
    expect(client.connects).toEqual([]);
  });

  test("a credentials provider that never answers times out, and the next refresh runs", async () => {
    vi.useFakeTimers();
    const client = new FakeConnection();
    client.status = "ready";
    const signer = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(new Promise<string>(() => {}))
      .mockResolvedValue("good-token");
    const auth = attachIamAuth(asRedis(client), NODE_BASED, { signer });

    await vi.advanceTimersByTimeAsync(DEFAULT_IAM_TOKEN_TIMEOUT_MS - 1);
    expect(errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/could not make an IAM auth token \(timed out after 10000 ms\)/);

    expect(await auth.refresh()).toBe(true);
    expect(client.options.password).toBe("good-token");
    auth.stop();
  });

  test("a token failure is logged and retried on the next tick, never thrown", async () => {
    vi.useFakeTimers();
    const client = new FakeConnection();
    client.status = "ready";
    const signer = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("Could not load credentials from any providers"))
      .mockResolvedValue("good-token");
    const auth = attachIamAuth(asRedis(client), NODE_BASED, { signer });
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/ElastiCache IAM token failed/);
    expect(errors[0]).toMatch(/Could not load credentials/);

    await vi.advanceTimersByTimeAsync(DEFAULT_IAM_REFRESH_INTERVAL_MS);
    expect(client.options.password).toBe("good-token");
    expect(client.auth).toHaveBeenCalledWith("app-user", "good-token");
    auth.stop();
  });

  test("a refused re-AUTH is logged naming IAM", async () => {
    const client = new FakeConnection();
    client.status = "ready";
    client.auth.mockRejectedValue(new Error("WRONGPASS invalid username-password pair"));
    const auth = attachIamAuth(asRedis(client), NODE_BASED, { signer: countingSigner() });
    await settle();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/ElastiCache IAM re-authentication failed/);
    expect(errors[0]).toMatch(/elasticache:Connect/);
    auth.stop();
  });

  test("an authentication error on connect is logged as an error naming IAM", async () => {
    const client = new FakeConnection();
    const auth = attachIamAuth(asRedis(client), NODE_BASED, { signer: countingSigner() });
    client.emit(
      "error",
      new Error("WRONGPASS invalid username-password pair or user is disabled."),
    );
    client.emit("error", new Error("connect ECONNREFUSED"));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/ElastiCache IAM authentication failed/);
    expect(errors[0]).toMatch(/IAM-enabled ElastiCache user/);
    expect(errors[0]).toMatch(/my-cache/);
    auth.stop();
  });

  test("isAuthError knows the refusals", () => {
    for (const message of [
      "WRONGPASS invalid username-password pair or user is disabled.",
      "NOAUTH Authentication required.",
      "Ready check failed: NOAUTH Authentication required.",
      "NOPERM this user has no permissions",
    ]) {
      expect(isAuthError(new Error(message))).toBe(true);
    }
    expect(isAuthError(new Error("connect ECONNREFUSED"))).toBe(false);
    expect(isAuthError("WRONGPASS")).toBe(false);
  });
});

describe("the token in logs", () => {
  test("never reaches a log line, from an error's command, message or a meta field", async () => {
    const token = await createIamTokenSigner(NODE_BASED, () => SIGNING_TIME)();
    const signature = new URLSearchParams(token.split("/?")[1]).get("X-Amz-Signature") ?? "";
    expect(signature).toHaveLength(64);

    const lines: string[] = [];
    setCacheLogger({
      error: (message, meta) => lines.push(message, JSON.stringify(meta), String(meta?.error)),
      warn: (message, meta) => lines.push(message, JSON.stringify(meta)),
    });
    try {
      // ioredis puts the failed command, arguments included, on a reply error.
      const error = Object.assign(new Error(`WRONGPASS for ${token}`), {
        command: { name: "auth", args: ["app-user", token] },
      });
      writeLog(
        () => ({ error: (m, meta) => lines.push(m, JSON.stringify(meta)), warn: () => {} }),
        "error",
        `[RedisCache]: AUTH failed with ${token}`,
        { error, password: token, nested: { value: token } },
      );
    } finally {
      setCacheLogger(undefined);
    }
    const output = lines.join("\n");
    expect(output).not.toContain(signature);
    expect(output).not.toContain(CREDENTIALS.sessionToken);
    expect(output).not.toContain("AKIDEXAMPLE%2F");
    expect(output).toContain("X-Amz-Signature=[redacted]");
  });

  test("the console gets the token scrubbed too", async () => {
    const token = await createIamTokenSigner(NODE_BASED, () => SIGNING_TIME)();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      writeLog(() => undefined, "error", `[RedisCache]: AUTH failed with ${token}`, {
        error: new Error(`refused ${token}`),
      });
      const printed = spy.mock.calls
        .flat()
        .map((arg) => (arg instanceof Error ? arg.message : String(arg)));
      expect(printed.join("\n")).not.toMatch(/X-Amz-Signature=[0-9a-f]{64}/);
    } finally {
      spy.mockRestore();
    }
  });
});
