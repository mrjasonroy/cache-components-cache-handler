import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  FALLBACK_BUILD_ID,
  deploymentScope,
  findBuildId,
  findCacheScope,
  findDeploymentId,
  getBuildId,
  getCacheScope,
  registerServerDistDir,
  resetBuildIdForTests,
} from "./build-id.js";

/**
 * The BUILD_ID Next 16 gives every build when a deployment ID is set (next/dist/build/index.js).
 */
const CONSTANT_BUILD_ID = "build-TfctsWXpff2fKS";

function appWithBuild(buildId: string, distDir = ".next"): string {
  const root = mkdtempSync(join(tmpdir(), "gn1618-build-"));
  mkdirSync(join(root, distDir, "server"), { recursive: true });
  writeFileSync(join(root, distDir, "BUILD_ID"), `${buildId}\n`);
  return root;
}

function writeServerFiles(root: string, deploymentId: string, distDir = ".next"): void {
  const manifest = { version: 1, config: { distDir, deploymentId }, files: [] };
  writeFileSync(join(root, distDir, "required-server-files.json"), JSON.stringify(manifest));
}

describe("build ID", () => {
  afterEach(() => {
    resetBuildIdForTests();
    vi.restoreAllMocks();
  });

  test("reads BUILD_ID next to the serverDistDir", () => {
    const root = appWithBuild("from-dist", "custom-dist");
    expect(findBuildId(join(root, "custom-dist", "server"), {}, "/nowhere")).toBe("from-dist");
  });

  test("a standalone server reads the distDir from __NEXT_PRIVATE_STANDALONE_CONFIG", () => {
    const root = appWithBuild("standalone", "out");
    const env = { __NEXT_PRIVATE_STANDALONE_CONFIG: JSON.stringify({ distDir: "./out" }) };
    expect(findBuildId(undefined, env, root)).toBe("standalone");
  });

  test("falls back to <cwd>/.next, then to the development ID", () => {
    expect(findBuildId(undefined, {}, appWithBuild("cwd"))).toBe("cwd");
    expect(findBuildId(undefined, { __NEXT_PRIVATE_STANDALONE_CONFIG: "{bad" }, "/nowhere")).toBe(
      FALLBACK_BUILD_ID,
    );
  });

  test("without a deployment ID the scope is the BUILD_ID", () => {
    expect(findCacheScope(undefined, {}, appWithBuild("b1"))).toBe("b1");
    expect(findCacheScope(undefined, { NEXT_DEPLOYMENT_ID: "" }, appWithBuild("b2"))).toBe("b2");
    const root = appWithBuild("b3");
    writeServerFiles(root, "");
    expect(findCacheScope(undefined, {}, root)).toBe("b3");
  });

  test("a deployment ID in required-server-files.json scopes keys instead of the BUILD_ID", () => {
    const root = appWithBuild(CONSTANT_BUILD_ID, "custom-dist");
    writeServerFiles(root, "dpl_1", "custom-dist");
    expect(findCacheScope(join(root, "custom-dist", "server"), {}, "/nowhere")).toBe("dpl_1");
  });

  test("a standalone server reads the deployment ID from __NEXT_PRIVATE_STANDALONE_CONFIG", () => {
    const root = appWithBuild(CONSTANT_BUILD_ID);
    writeServerFiles(root, "stale");
    const env = { __NEXT_PRIVATE_STANDALONE_CONFIG: JSON.stringify({ deploymentId: "dpl_s" }) };
    expect(findCacheScope(undefined, env, root)).toBe("dpl_s");
  });

  test("NEXT_DEPLOYMENT_ID is used when the config's deploymentId is '' (runtimeServerDeploymentId)", () => {
    const root = appWithBuild(CONSTANT_BUILD_ID);
    writeServerFiles(root, "");
    expect(findCacheScope(undefined, { NEXT_DEPLOYMENT_ID: "dpl_env" }, root)).toBe("dpl_env");
    const standalone = { __NEXT_PRIVATE_STANDALONE_CONFIG: JSON.stringify({ deploymentId: "" }) };
    expect(findDeploymentId(undefined, { ...standalone, NEXT_DEPLOYMENT_ID: "dpl_e" }, root)).toBe(
      "dpl_e",
    );
    expect(findDeploymentId(undefined, { NEXT_DEPLOYMENT_ID: "dpl_only" }, "/nowhere")).toBe(
      "dpl_only",
    );
  });

  test("the config's deploymentId wins over NEXT_DEPLOYMENT_ID", () => {
    const root = appWithBuild(CONSTANT_BUILD_ID);
    writeServerFiles(root, "dpl_config");
    expect(findDeploymentId(undefined, { NEXT_DEPLOYMENT_ID: "" }, root)).toBe("dpl_config");
    expect(findDeploymentId(undefined, { NEXT_DEPLOYMENT_ID: "other" }, root)).toBe("dpl_config");
  });

  test("two builds with the same constant BUILD_ID and different deployment IDs never share a scope", () => {
    const first = appWithBuild(CONSTANT_BUILD_ID);
    const second = appWithBuild(CONSTANT_BUILD_ID);
    writeServerFiles(first, "dpl_a");
    writeServerFiles(second, "dpl_b");
    expect(findBuildId(undefined, {}, first)).toBe(findBuildId(undefined, {}, second));
    expect(findCacheScope(undefined, {}, first)).not.toBe(findCacheScope(undefined, {}, second));
  });

  test("a deployment ID is encoded for use as a key segment", () => {
    expect(deploymentScope("dpl_abc-1.2")).toBe("dpl_abc-1.2");
    expect(deploymentScope("a:b c[d]")).toBe("a%3Ab%20c%5Bd%5D");
    expect(deploymentScope("a:b")).not.toBe(deploymentScope("a%3Ab"));
    expect(findCacheScope(undefined, { NEXT_DEPLOYMENT_ID: "x:page:y" }, "/nowhere")).toBe(
      "x%3Apage%3Ay",
    );
  });

  test("getCacheScope uses the registered serverDistDir and is fixed once resolved", () => {
    const first = appWithBuild(CONSTANT_BUILD_ID);
    writeServerFiles(first, "dpl_first");
    registerServerDistDir(join(first, ".next", "server"));
    expect(getCacheScope()).toBe("dpl_first");
    expect(getBuildId()).toBe(CONSTANT_BUILD_ID);
    writeServerFiles(first, "dpl_changed");
    expect(getCacheScope()).toBe("dpl_first");
  });

  test("getBuildId uses the registered serverDistDir and is fixed once resolved", () => {
    const first = appWithBuild("first");
    const second = appWithBuild("second");
    registerServerDistDir(join(first, ".next", "server"));
    registerServerDistDir(join(second, ".next", "server"));
    expect(getBuildId()).toBe("first");
    resetBuildIdForTests();
    registerServerDistDir(join(second, ".next", "server"));
    expect(getBuildId()).toBe("second");
  });
});
