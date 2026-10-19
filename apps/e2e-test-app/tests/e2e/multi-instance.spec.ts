import { expect, test } from "@playwright/test";
import {
  INSTANCE_A,
  INSTANCE_B,
  isRedisLane,
  readStamp,
  revalidate,
  uniqueId,
  waitForChange,
  waitForStable,
} from "./helpers/cache";

// Two `next start` processes (3000 and 3001) sharing one Redis. Invalidation on A must reach B.
test.describe("Two instances sharing Redis", () => {
  test.skip(!isRedisLane, "needs Redis and the second instance");

  test('"use cache: remote" is shared, and revalidateTag on A refreshes B', async () => {
    const id = uniqueId("multi-remote");
    const path = `/e2e/data?id=${id}`;

    const onA = await waitForStable(INSTANCE_A, path, "remote");
    await expect(async () => {
      expect(await readStamp(INSTANCE_B, path, "remote")).toBe(onA);
    }).toPass({ timeout: 15_000 });

    await revalidate(INSTANCE_A, { tag: `e2e-remote-${id}` });
    await waitForChange(INSTANCE_B, path, "remote", onA);
  });

  test('"use cache" on B is invalidated by revalidateTag on A (distributed tags)', async () => {
    const id = uniqueId("multi-local");
    const path = `/e2e/data?id=${id}`;

    // Per-instance memory by default: B holds its own value, which only a shared tag
    // invalidation can expire.
    await waitForStable(INSTANCE_A, path, "local");
    const onB = await waitForStable(INSTANCE_B, path, "local");

    await revalidate(INSTANCE_A, { tag: `e2e-local-${id}` });
    await waitForChange(INSTANCE_B, path, "local", onB);
  });

  test("pages are shared, and revalidatePath on A refreshes B", async () => {
    const path = "/e2e/page-shared";

    const onA = await waitForStable(INSTANCE_A, path, "stamp");
    await expect(async () => {
      expect(await readStamp(INSTANCE_B, path, "stamp")).toBe(onA);
    }).toPass({ timeout: 15_000 });

    await revalidate(INSTANCE_A, { path });
    const fresh = await waitForChange(INSTANCE_B, path, "stamp", onA);

    // The re-rendered page is shared again: A converges on B's new copy.
    await expect(async () => {
      expect(await readStamp(INSTANCE_A, path, "stamp")).toBe(
        await readStamp(INSTANCE_B, path, "stamp"),
      );
    }).toPass({ timeout: 30_000, intervals: [500, 1000] });
    expect(fresh).not.toBe(onA);
  });
});
