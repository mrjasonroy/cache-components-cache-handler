import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import {
  INSTANCE_A,
  INSTANCE_B,
  isRedisLane,
  readStamp,
  readTagRecord,
  revalidate,
  uniqueId,
} from "./helpers/cache";

test("a page render crossing a hard invalidation cannot populate a fresh shell", async () => {
  const id = uniqueId("race");
  let version = "1";
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  const origin = createServer(async (_request, response) => {
    const snapshot = version;
    started = true;
    await held;
    response.end(snapshot);
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const address = origin.address();
  if (!address || typeof address === "string") throw new Error("Missing origin port");
  const path = `/e2e/inflight/${address.port}/${id}`;
  const rendering = readStamp(INSTANCE_A, path, "version");
  try {
    await expect.poll(() => started).toBe(true);
    version = "2";
    await revalidate(isRedisLane ? INSTANCE_B : INSTANCE_A, { tag: `inflight-${id}` });
    if (isRedisLane) {
      // HTTP completion can precede Next's pending revalidation work. Observe its commit.
      await expect.poll(async () => (await readTagRecord(`inflight-${id}`)).record).toBeTruthy();
    }
    release();
    await rendering;
    // First read must be current; retrying until fresh would hide the regression.
    expect(await readStamp(isRedisLane ? INSTANCE_B : INSTANCE_A, path, "version")).toBe("2");
    expect(await readStamp(INSTANCE_A, path, "version")).toBe("2");
  } finally {
    release();
    await rendering.catch(() => {});
    origin.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      origin.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
