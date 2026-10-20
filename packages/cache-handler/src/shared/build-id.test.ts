import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  FALLBACK_BUILD_ID,
  findBuildId,
  getBuildId,
  registerServerDistDir,
  resetBuildIdForTests,
} from "./build-id.js";

function appWithBuild(buildId: string, distDir = ".next"): string {
  const root = mkdtempSync(join(tmpdir(), "gn1618-build-"));
  mkdirSync(join(root, distDir, "server"), { recursive: true });
  writeFileSync(join(root, distDir, "BUILD_ID"), `${buildId}\n`);
  return root;
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
