import { describe, expect, test } from "vitest";
import {
  isBuildPhase,
  isDebugEnabled,
  isRedisDisabled,
  resolveConnectionOptions,
  resolveEnvConnectionOptions,
  resolveIamOptions,
  resolveKeyPrefix,
  shouldUseRedis,
} from "./env.js";

describe("env resolution", () => {
  test("build phase and CACHE_REDIS=off disable Redis", () => {
    expect(isBuildPhase({ NEXT_PHASE: "phase-production-build" })).toBe(true);
    expect(isBuildPhase({ NEXT_PHASE: "phase-production-server" })).toBe(false);
    for (const value of ["off", "0", "false", "no", "OFF"]) {
      expect(isRedisDisabled({ CACHE_REDIS: value })).toBe(true);
    }
    expect(isRedisDisabled({ CACHE_REDIS: "on" })).toBe(false);
    expect(shouldUseRedis({})).toBe(true);
    expect(shouldUseRedis({ NEXT_PHASE: "phase-production-build" })).toBe(false);
    expect(shouldUseRedis({ CACHE_REDIS: "off" })).toBe(false);
  });

  test("CACHE_DEBUG and CACHE_KEY_PREFIX", () => {
    expect(isDebugEnabled({ CACHE_DEBUG: "1" })).toBe(true);
    expect(isDebugEnabled({ CACHE_DEBUG: "true" })).toBe(true);
    expect(isDebugEnabled({})).toBe(false);
    expect(resolveKeyPrefix({})).toBe("nextjs:");
    expect(resolveKeyPrefix({ CACHE_KEY_PREFIX: "shop:" })).toBe("shop:");
  });

  test("a URL wins: option, then REDIS_URL, then VALKEY_URL", () => {
    expect(
      resolveEnvConnectionOptions({ url: "redis://opt" }, { REDIS_URL: "redis://env" })?.url,
    ).toBe("redis://opt");
    expect(
      resolveEnvConnectionOptions({}, { REDIS_URL: "redis://env", VALKEY_URL: "redis://v" })?.url,
    ).toBe("redis://env");
    expect(resolveEnvConnectionOptions({}, { VALKEY_URL: "redis://v" })?.url).toBe("redis://v");
  });

  test("an ElastiCache endpoint without a URL", () => {
    expect(
      resolveEnvConnectionOptions(
        {},
        {
          ELASTICACHE_ENDPOINT: "cache.aws",
          ELASTICACHE_PORT: "6380",
          ELASTICACHE_AUTH_TOKEN: "tok",
        },
      ),
    ).toMatchObject({ host: "cache.aws", port: 6380, tls: true, password: "tok" });
    expect(
      resolveEnvConnectionOptions({}, { ELASTICACHE_ENDPOINT: "c", ELASTICACHE_TLS: "false" })?.tls,
    ).toBe(false);
  });

  test("nothing configured: undefined (memory only)", () => {
    expect(resolveEnvConnectionOptions({}, {})).toBeUndefined();
  });

  test("an explicit type falls back to localhost; elasticache needs an endpoint", () => {
    expect(resolveConnectionOptions({ type: "redis" }, {}).url).toBe("redis://localhost:6379");
    expect(resolveConnectionOptions({ type: "valkey", commandTimeout: 5 }, {})).toMatchObject({
      commandTimeout: 5,
    });
    expect(() => resolveConnectionOptions({ type: "elasticache" }, {})).toThrow(/endpoint/);
    expect(resolveConnectionOptions({ type: "redis" }, { REDIS_PASSWORD: "pw" }).password).toBe(
      "pw",
    );
  });
});

describe("ElastiCache IAM from the environment", () => {
  const IAM_ENV = {
    ELASTICACHE_ENDPOINT: "master.my-cache.abc123.use1.cache.amazonaws.com",
    ELASTICACHE_IAM_USER: "app-user",
    ELASTICACHE_CACHE_NAME: "My-Cache",
    ELASTICACHE_REGION: "us-east-1",
  };

  test("ELASTICACHE_IAM_USER turns IAM on for the host form, replacing the password", () => {
    const options = resolveEnvConnectionOptions({}, { ...IAM_ENV, ELASTICACHE_AUTH_TOKEN: "tok" });
    expect(options).toMatchObject({
      host: IAM_ENV.ELASTICACHE_ENDPOINT,
      tls: true,
      iam: { userId: "app-user", cacheName: "my-cache", region: "us-east-1", serverless: false },
    });
    expect(options?.password).toBeUndefined();
  });

  test("no IAM without ELASTICACHE_IAM_USER or the iam option", () => {
    expect(
      resolveEnvConnectionOptions({}, { ...IAM_ENV, ELASTICACHE_IAM_USER: "" })?.iam,
    ).toBeUndefined();
    expect(resolveIamOptions(undefined, { host: "h", tls: true }, {})).toBeUndefined();
  });

  test("the region falls back to AWS_REGION, then AWS_DEFAULT_REGION", () => {
    const { ELASTICACHE_REGION: _region, ...env } = IAM_ENV;
    expect(
      resolveEnvConnectionOptions({}, { ...env, AWS_REGION: "eu-west-1", AWS_DEFAULT_REGION: "x" })
        ?.iam?.region,
    ).toBe("eu-west-1");
    expect(
      resolveEnvConnectionOptions({}, { ...env, AWS_DEFAULT_REGION: "ap-south-1" })?.iam?.region,
    ).toBe("ap-south-1");
  });

  test("serverless: ELASTICACHE_SERVERLESS, else a .serverless. hostname", () => {
    const serverlessHost = "my-cache-abc123.serverless.use1.cache.amazonaws.com";
    expect(
      resolveEnvConnectionOptions({}, { ...IAM_ENV, ELASTICACHE_ENDPOINT: serverlessHost })?.iam
        ?.serverless,
    ).toBe(true);
    expect(
      resolveEnvConnectionOptions({}, { ...IAM_ENV, ELASTICACHE_SERVERLESS: "true" })?.iam
        ?.serverless,
    ).toBe(true);
    expect(
      resolveEnvConnectionOptions(
        {},
        { ...IAM_ENV, ELASTICACHE_ENDPOINT: serverlessHost, ELASTICACHE_SERVERLESS: "false" },
      )?.iam?.serverless,
    ).toBe(false);
  });

  test("a rediss:// URL works with IAM; a redis:// one throws", () => {
    const url = "rediss://my-cache-abc123.serverless.use1.cache.amazonaws.com:6379";
    expect(resolveEnvConnectionOptions({}, { ...IAM_ENV, REDIS_URL: url })?.iam).toMatchObject({
      userId: "app-user",
      serverless: true,
    });
    expect(() =>
      resolveEnvConnectionOptions({}, { ...IAM_ENV, REDIS_URL: "redis://cache:6379" }),
    ).toThrow(/TLS is off/);
  });

  test("throws loudly, naming everything that is missing", () => {
    expect(() => resolveEnvConnectionOptions({}, { ...IAM_ENV, ELASTICACHE_TLS: "false" })).toThrow(
      /ElastiCache IAM authentication cannot work: TLS is off/,
    );
    expect(() =>
      resolveEnvConnectionOptions(
        {},
        { ELASTICACHE_ENDPOINT: "cache.aws", ELASTICACHE_IAM_USER: "app-user" },
      ),
    ).toThrow(/ELASTICACHE_CACHE_NAME.*ELASTICACHE_REGION/);
    expect(() => resolveIamOptions({}, { host: "h", tls: true }, {})).toThrow(
      /ELASTICACHE_IAM_USER/,
    );
  });

  test("the iam option wins over the environment, field by field", () => {
    const credentials = async () => ({ accessKeyId: "a", secretAccessKey: "b" });
    expect(
      resolveIamOptions(
        { cacheName: "other", serverless: true, credentials },
        { host: "h", tls: true },
        IAM_ENV,
      ),
    ).toEqual({
      userId: "app-user",
      cacheName: "other",
      region: "us-east-1",
      serverless: true,
      credentials,
    });
  });
});
