import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resetCacheState } from "../testing/env.js";
import {
  BUILD_STAMP_FILE,
  readBuildTime,
  readRoutePeriods,
  resetBuildInfoForTests,
  writeBuildStamp,
} from "./build-info.js";
import { RedisCacheHandler } from "./redis.js";

let distDir: string;
let serverDistDir: string;

function stamp(): unknown {
  return JSON.parse(readFileSync(join(serverDistDir, BUILD_STAMP_FILE), "utf8"));
}

/** `next build` wrote BUILD_ID; a new process reads it. */
async function buildId(id: string): Promise<void> {
  writeFileSync(join(distDir, "BUILD_ID"), id);
  await resetCacheState();
  new RedisCacheHandler({ serverDistDir });
}

describe("build stamp", () => {
  beforeEach(async () => {
    await resetCacheState();
    distDir = mkdtempSync(join(tmpdir(), "cch-info-"));
    serverDistDir = join(distDir, "server");
    mkdirSync(serverDistDir);
  });

  afterEach(async () => {
    await resetCacheState();
    rmSync(distDir, { recursive: true, force: true });
  });

  test("the page handler writes it when constructed during next build", async () => {
    await buildId("b1");
    process.env.NEXT_PHASE = "phase-production-build";
    const before = Date.now();
    new RedisCacheHandler({ serverDistDir });
    const written = stamp() as { buildTime: number; buildId: string };
    expect(written.buildId).toBe("b1");
    expect(written.buildTime).toBeGreaterThanOrEqual(before);
  });

  test("not at runtime", async () => {
    await buildId("b1");
    new RedisCacheHandler({ serverDistDir });
    expect(() => stamp()).toThrow(/ENOENT/);
  });

  test("the first write of a build wins; the build's other workers keep it", async () => {
    await buildId("b1");
    writeBuildStamp(serverDistDir, 1000);
    writeBuildStamp(serverDistDir, 2000);
    expect(stamp()).toEqual({ buildTime: 1000, buildId: "b1" });
  });

  test("a stamp left by another build (cleanDistDir: false) is replaced", async () => {
    await buildId("b1");
    writeBuildStamp(serverDistDir, 1000);
    await buildId("b2");
    writeBuildStamp(serverDistDir, 2000);
    expect(stamp()).toEqual({ buildTime: 2000, buildId: "b2" });
  });

  test("a real build: constructed before BUILD_ID exists, then again in the same worker after it", async () => {
    // next@16.4.2 runs "collecting page data" and static generation in the same workers, and
    // constructs the handler in both; BUILD_ID is written between them.
    process.env.NEXT_PHASE = "phase-production-build";
    const collecting = Date.now();
    new RedisCacheHandler({ serverDistDir });
    expect(stamp()).toEqual({ buildTime: expect.any(Number) });

    writeFileSync(join(distDir, "BUILD_ID"), "b1");
    new RedisCacheHandler({ serverDistDir });
    const written = stamp() as { buildTime: number; buildId: string };
    expect(written.buildId).toBe("b1");
    // The earliest time is kept: it precedes every prerender.
    expect(written.buildTime).toBeGreaterThanOrEqual(collecting);
    expect(written.buildTime).toBeLessThanOrEqual(Date.now());

    resetBuildInfoForTests();
    await buildId("b1");
    expect(readBuildTime(serverDistDir)).toBe(written.buildTime);
  });

  test("a stamp left by another build is replaced even before this build's BUILD_ID exists", async () => {
    await buildId("old");
    writeBuildStamp(serverDistDir, 1000);
    rmSync(join(distDir, "BUILD_ID"));
    writeBuildStamp(serverDistDir, 2000);
    writeFileSync(join(distDir, "BUILD_ID"), "new");
    writeBuildStamp(serverDistDir, 3000);
    expect(stamp()).toEqual({ buildTime: 2000, buildId: "new" });
  });

  test("readBuildTime: the stamp's time when it names this build, else undefined", async () => {
    await buildId("b1");
    writeBuildStamp(serverDistDir, 1000);
    expect(readBuildTime(serverDistDir)).toBe(1000);

    await buildId("b2");
    expect(readBuildTime(serverDistDir)).toBeUndefined();

    writeFileSync(join(serverDistDir, BUILD_STAMP_FILE), "{not json");
    resetBuildInfoForTests();
    expect(readBuildTime(serverDistDir)).toBeUndefined();
  });

  test("readRoutePeriods: the manifest's periods, by Next's route for the cache key", async () => {
    writeFileSync(
      join(distDir, "prerender-manifest.json"),
      JSON.stringify({
        routes: {
          "/": { initialRevalidateSeconds: 60, initialExpireSeconds: 300 },
          "/static": { initialRevalidateSeconds: false },
        },
      }),
    );
    expect(readRoutePeriods(serverDistDir, "/index")).toEqual({ revalidate: 60, expire: 300 });
    expect(readRoutePeriods(serverDistDir, "/static")).toEqual({ revalidate: false });
    expect(readRoutePeriods(serverDistDir, "/other")).toBeUndefined();
  });

  test("readRoutePeriods: Next 16.4's route cache keys map to the manifest's routes", async () => {
    const { getRouteCacheKey } = createRequire(import.meta.url)(
      "next/dist/server/lib/route-cache-key.js",
    ) as { getRouteCacheKey: (pathname: string, owner: object) => string };
    const key = (sourceRoute: string, pathname: string) =>
      getRouteCacheKey(pathname, { kind: "APP_PAGE", sourceRoute });
    writeFileSync(
      join(distDir, "prerender-manifest.json"),
      JSON.stringify({
        routes: {
          "/": { initialRevalidateSeconds: 60 },
          "/index": { initialRevalidateSeconds: 120 },
          "/index/nested": { initialRevalidateSeconds: 180 },
          "/routes/io-cached": { initialRevalidateSeconds: false },
          "/blog/a": { initialRevalidateSeconds: 240 },
        },
      }),
    );
    expect(readRoutePeriods(serverDistDir, key("/page", "/"))).toEqual({ revalidate: 60 });
    expect(readRoutePeriods(serverDistDir, key("/index/page", "/index"))).toEqual({
      revalidate: 120,
    });
    expect(readRoutePeriods(serverDistDir, key("/index/nested/page", "/index/nested"))).toEqual({
      revalidate: 180,
    });
    expect(
      readRoutePeriods(serverDistDir, key("/routes/io-cached/route", "/routes/io-cached")),
    ).toEqual({ revalidate: false });
    expect(readRoutePeriods(serverDistDir, key("/blog/[slug]/page", "/blog/a"))).toEqual({
      revalidate: 240,
    });
    expect(readRoutePeriods(serverDistDir, key("/blog/[slug]/page", "/blog/b"))).toBeUndefined();
  });
});
