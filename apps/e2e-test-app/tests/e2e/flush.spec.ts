import { expect, test } from "@playwright/test";
import {
  INSTANCE_A,
  KEY_PREFIX,
  buildId,
  isRedisLane,
  readTagRecord,
  revalidate,
  scanKeys,
  uniqueId,
  waitForStable,
} from "./helpers/cache";

const FLUSH_TOKEN = process.env.E2E_FLUSH_TOKEN ?? "";

function flush(token: string, scope?: "build" | "all") {
  return fetch(`${INSTANCE_A}/api/e2e/flush`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(scope ? { scope } : {}),
  });
}

test.describe("flushCache", () => {
  test.skip(!isRedisLane || !FLUSH_TOKEN, "needs Redis and E2E_FLUSH_TOKEN");

  test("rejects a request without the token", async () => {
    const response = await flush("wrong-token");
    expect(response.status).toBe(401);
  });

  test("removes this build's keys and keeps the tag records", async () => {
    const id = uniqueId("flush");
    await waitForStable(INSTANCE_A, "/e2e/page-flush", "stamp");
    await waitForStable(INSTANCE_A, `/e2e/data?id=${id}`, "remote");
    await revalidate(INSTANCE_A, { tag: `e2e-data-${id}` });

    const buildPattern = `${KEY_PREFIX}${buildId()}:*`;
    await expect(async () => {
      expect(await scanKeys(buildPattern)).not.toHaveLength(0);
    }).toPass({ timeout: 10_000 });

    const tagBefore = await readTagRecord(`e2e-data-${id}`);
    expect(tagBefore.record).not.toBeNull();
    expect(tagBefore.indexScore).not.toBeNull();

    const response = await flush(FLUSH_TOKEN);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { deleted: number };
    expect(body.deleted).toBeGreaterThan(0);

    expect(await scanKeys(buildPattern)).toHaveLength(0);
    // Tag records sit above the build ID, so a build-scope flush leaves them as they were.
    expect(await readTagRecord(`e2e-data-${id}`)).toEqual(tagBefore);
  });
});
