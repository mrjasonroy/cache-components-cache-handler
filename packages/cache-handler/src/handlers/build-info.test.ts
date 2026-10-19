import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("nothing is written before Next has written BUILD_ID (collecting page data)", async () => {
    await resetCacheState();
    writeBuildStamp(serverDistDir, 1000);
    expect(() => stamp()).toThrow(/ENOENT/);
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
});
