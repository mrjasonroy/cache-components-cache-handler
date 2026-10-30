import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createPortServer } from "node:net";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import Redis from "ioredis";

const fixture = resolve(process.cwd(), "tests/fixtures/plain-cache");
const next = createRequire(resolve(process.cwd(), "package.json")).resolve("next/dist/bin/next");
const prefix = `plain-cache-test:${randomUUID()}:`;
const servers: ChildProcess[] = [];
let urls: string[] = [];
let redis: Redis;
let logs = "";

function run(args: string[]): ChildProcess {
  const child = spawn(process.execPath, [next, ...args], {
    cwd: fixture,
    env: { ...process.env, CACHE_KEY_PREFIX: prefix, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    logs += chunk.toString();
  });
  return child;
}

async function port(): Promise<number> {
  const server = createPortServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function read(base: string, origin: string, id: string): Promise<string> {
  const response = await fetch(`${base}/value?${new URLSearchParams({ origin, id })}`);
  expect(response.status, logs).toBe(200);
  return (await response.json()).value;
}

async function invalidate(base: string, id: string): Promise<void> {
  const response = await fetch(`${base}/value`, {
    method: "POST",
    body: JSON.stringify({ id }),
    headers: { "content-type": "application/json" },
  });
  expect(response.status, logs).toBe(200);
  // Next finishes pending revalidation after responding; observe the acknowledged write.
  await expect.poll(() => redis.hget(`${prefix}tags`, `plain-${id}`)).toBeTruthy();
}

test.describe("plain use cache opted into Redis", () => {
  test.skip(
    !process.env.REDIS_URL || process.env.E2E_CONFIG === "16.4.2",
    "needs current package and Redis",
  );
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const build = run(["build", "--webpack"]);
    servers.push(build);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        build.once("error", reject);
        build.once("exit", resolve);
      });
      expect(code, logs).toBe(0);
    } finally {
      await stop(build);
    }
    redis = new Redis(process.env.REDIS_URL as string);
    for (let i = 0; i < 2; i++) {
      const address = `http://127.0.0.1:${await port()}`;
      const child = run(["start", "--hostname", "127.0.0.1", "--port", new URL(address).port]);
      servers.push(child);
      urls.push(address);
      await expect
        .poll(
          async () => {
            try {
              return (await fetch(address)).status;
            } catch {
              return 0;
            }
          },
          { timeout: 30_000, message: logs },
        )
        .toBe(404);
    }
  });

  test.afterAll(async () => {
    for (const child of servers) await stop(child);
    urls = [];
    if (redis) {
      let cursor = "0";
      do {
        const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 100);
        if (keys.length) await redis.del(...keys);
        cursor = next;
      } while (cursor !== "0");
      redis.disconnect();
    }
  });

  for (const inflight of [false, true]) {
    test(inflight
      ? "invalidation during a render expires the completed entry"
      : "another process reads shared values and is fresh on its first read after invalidation", async () => {
      const id = randomUUID();
      let version = "1";
      let started = false;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (!inflight) release();
      const origin = createServer(async (_request, response) => {
        const snapshot = version;
        started = true;
        await held;
        response.end(snapshot);
      });
      await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
      const address = origin.address();
      if (!address || typeof address === "string") throw new Error("Missing origin port");
      const source = `http://127.0.0.1:${address.port}`;
      const rendering = read(urls[0], source, id);
      try {
        if (inflight) {
          await expect.poll(() => started).toBe(true);
        } else {
          expect(await rendering).toBe("1");
          // Wait for the initial async cache write before the sharing assertion.
          await expect
            .poll(async () => (await redis.keys(`${prefix}*:data:*`)).length)
            .toBeGreaterThan(0);
          version = "2";
          expect(await read(urls[1], source, id)).toBe("1");
        }
        version = "2";
        await invalidate(urls[1], id);
        release();
        await rendering;
        // No retries: B's very next read must be fresh, including the late-write race.
        expect(await read(urls[1], source, id)).toBe("2");
        expect(await read(urls[0], source, id)).toBe("2");
      } finally {
        release();
        await rendering.catch(() => {});
        origin.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          origin.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  }
});
