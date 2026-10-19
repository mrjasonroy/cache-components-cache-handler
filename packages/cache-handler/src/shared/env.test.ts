import { describe, expect, test } from "vitest";
import {
  isBuildPhase,
  isDebugEnabled,
  isRedisDisabled,
  resolveConnectionOptions,
  resolveEnvConnectionOptions,
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
