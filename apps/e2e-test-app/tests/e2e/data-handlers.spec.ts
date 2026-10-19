import { expect, test } from "@playwright/test";
import {
  INSTANCE_A,
  KEY_PREFIX,
  buildKeyPattern,
  isRedisLane,
  revalidate,
  scanKeys,
  uniqueId,
  waitForChange,
  waitForStable,
} from "./helpers/cache";

// "use cache" (cacheHandlers.default) and "use cache: remote" (cacheHandlers.remote).
test.describe('Data handlers ("use cache" / "use cache: remote")', () => {
  test("caches both kinds", async () => {
    const id = uniqueId("data-hit");
    const path = `/e2e/data?id=${id}`;

    await waitForStable(INSTANCE_A, path, "local");
    await waitForStable(INSTANCE_A, path, "remote");

    if (isRedisLane) {
      // "use cache: remote" entries live in Redis: <prefix><buildId>:data:<key>
      await expect(async () => {
        expect(await scanKeys(buildKeyPattern("data"))).not.toHaveLength(0);
      }).toPass({ timeout: 10_000 });
    }
  });

  test("revalidateTag refreshes both kinds", async () => {
    const id = uniqueId("data-tag");
    const path = `/e2e/data?id=${id}`;

    const local = await waitForStable(INSTANCE_A, path, "local");
    const remote = await waitForStable(INSTANCE_A, path, "remote");

    await revalidate(INSTANCE_A, { tag: `e2e-data-${id}` });

    await waitForChange(INSTANCE_A, path, "local", local);
    await waitForChange(INSTANCE_A, path, "remote", remote);

    if (isRedisLane) {
      // Tag records sit above the build ID: <prefix>tag:<tag>
      expect(await scanKeys(`${KEY_PREFIX}tag:e2e-data-${id}`)).toHaveLength(1);
    }
  });
});
