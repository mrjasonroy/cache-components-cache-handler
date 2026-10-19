import { expect, test } from "@playwright/test";
import {
  INSTANCE_A,
  buildKeyPattern,
  isRedisLane,
  revalidate,
  scanKeys,
  waitForChange,
  waitForStable,
} from "./helpers/cache";

// Static pages go through `cacheHandler` (the page handler withCache configures).
test.describe("Page handler (cacheHandler)", () => {
  test("serves the second request from the cache", async () => {
    await waitForStable(INSTANCE_A, "/e2e/page-hit", "stamp");

    if (isRedisLane) {
      // The page entry is in Redis under the build namespace: <prefix><buildId>:page:<key>
      await expect(async () => {
        expect(await scanKeys(buildKeyPattern("page", "page-hit"))).not.toHaveLength(0);
      }).toPass({ timeout: 10_000 });
    }
  });

  test("revalidatePath re-renders the page", async () => {
    const before = await waitForStable(INSTANCE_A, "/e2e/page-path", "stamp");
    await revalidate(INSTANCE_A, { path: "/e2e/page-path" });
    await waitForChange(INSTANCE_A, "/e2e/page-path", "stamp", before);
  });

  test("revalidateTag re-renders the page", async () => {
    const before = await waitForStable(INSTANCE_A, "/e2e/page-tag", "stamp");
    await revalidate(INSTANCE_A, { tag: "e2e-page-tag" });
    await waitForChange(INSTANCE_A, "/e2e/page-tag", "stamp", before);
  });
});
