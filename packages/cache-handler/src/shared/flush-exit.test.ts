/**
 * `flushCache` in a plain Node process (a script, a test runner, a CLI) must let it exit: a Redis
 * client the flush opened and left open keeps the process alive, retrying forever once Redis has
 * gone. Runs the compiled package in a child process.
 *
 * The reachable case runs only when `CACHE_TEST_REDIS_URL` points at a disposable Redis:
 *
 * ```sh
 * docker run -d --name cache-test-redis -p 6390:6379 redis:7-alpine
 * CACHE_TEST_REDIS_URL=redis://localhost:6390 pnpm --filter @mrjasonroy/cache-components-cache-handler \
 *   exec vitest run src/shared/flush-exit.test.ts
 * ```
 */

import { execFileSync, spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Inside the package, so the compiled code resolves `ioredis` from its node_modules.
const outDir = join(packageDir, "node_modules", ".cache", "flush-exit-test");
const script = join(outDir, "flush-script.mjs");
const redisUrl = process.env.CACHE_TEST_REDIS_URL;

/** Exit allowance: the connect timeout (2 s) and initial wait (0.5 s), with room to spare. */
const EXIT_WITHIN_MS = 8_000;

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Run `flushCache({ url })` in a child process; whether it exited by itself, and its output. */
function runFlush(url: string): { exited: boolean; output: string } {
  const result = spawnSync(process.execPath, [script, url], {
    timeout: EXIT_WITHIN_MS,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "production" },
  });
  return { exited: result.signal === null, output: `${result.stdout}${result.stderr}` };
}

describe("flushCache lets a plain Node process exit", () => {
  beforeAll(() => {
    rmSync(outDir, { recursive: true, force: true });
    execFileSync(
      join(packageDir, "node_modules", ".bin", "tsc"),
      [
        "-p",
        join(packageDir, "tsconfig.json"),
        "--outDir",
        outDir,
        "--declaration",
        "false",
        "--declarationMap",
        "false",
        "--sourceMap",
        "false",
      ],
      { stdio: "inherit" },
    );
    writeFileSync(
      script,
      [
        'import { flushCache } from "./index.js";',
        "try {",
        '  const result = await flushCache({ url: process.argv[2], keyPrefix: "flush-exit-test:" });',
        '  console.log("flushed", JSON.stringify(result));',
        "} catch (error) {",
        '  console.log("failed", error.message);',
        "}",
      ].join("\n"),
    );
  }, 120_000);

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  test("Redis unreachable: the flush fails and the process exits", async () => {
    const { exited, output } = runFlush(`redis://127.0.0.1:${await closedPort()}`);
    expect(exited, output).toBe(true);
    expect(output).toContain("failed flushCache: Redis is unavailable");
  });

  test.skipIf(!redisUrl)("Redis reachable: the flush succeeds and the process exits", () => {
    const { exited, output } = runFlush(redisUrl as string);
    expect(exited, output).toBe(true);
    expect(output).toContain('flushed {"deleted":');
  });
});
