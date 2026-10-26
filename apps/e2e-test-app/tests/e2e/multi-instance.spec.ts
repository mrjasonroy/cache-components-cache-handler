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

/**
 * B's `refreshTags` syncs tag records at most every 100 ms, so give it a moment past the
 * revalidation before asserting on its very next read.
 */
function settleTagSync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1_000));
}

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

  test('plain "use cache" is per instance, "use cache: remote" is shared', async () => {
    const id = uniqueId("multi-split");
    const path = `/e2e/data?id=${id}`;

    // Each instance renders and keeps its own "use cache" value: the stamps differ.
    const localA = await waitForStable(INSTANCE_A, path, "local");
    const localB = await waitForStable(INSTANCE_B, path, "local");
    expect(localB, '"use cache" must not be shared through Redis').not.toBe(localA);

    // The remote value from the same page is one copy in Redis for both.
    const remoteA = await waitForStable(INSTANCE_A, path, "remote");
    await expect(async () => {
      expect(await readStamp(INSTANCE_B, path, "remote")).toBe(remoteA);
    }).toPass({ timeout: 15_000 });
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

  test("revalidateTag(tag) with no profile on A makes B's next read a miss", async () => {
    const id = uniqueId("multi-none");
    const path = `/e2e/data?id=${id}`;

    const onA = await waitForStable(INSTANCE_A, path, "remote");
    await expect(async () => {
      expect(await readStamp(INSTANCE_B, path, "remote")).toBe(onA);
    }).toPass({ timeout: 15_000 });

    // No durations reach updateTags: the record expires now, so there is no stale window.
    await revalidate(INSTANCE_A, { tag: `e2e-remote-${id}`, profile: "none" });
    await settleTagSync();

    const fresh = await readStamp(INSTANCE_B, path, "remote");
    expect(fresh, "B's first read after the revalidation must be a fresh render").not.toBe(onA);
  });

  test('revalidateTag(tag, "max") on A: B serves the old value once more, then a new one', async () => {
    const id = uniqueId("multi-max");
    const path = `/e2e/data?id=${id}`;

    const onA = await waitForStable(INSTANCE_A, path, "remote");
    await expect(async () => {
      expect(await readStamp(INSTANCE_B, path, "remote")).toBe(onA);
    }).toPass({ timeout: 15_000 });

    await revalidate(INSTANCE_A, { tag: `e2e-remote-${id}`, profile: "max" });
    await settleTagSync();

    // Stale-while-revalidate: the stale entry is served and regenerated in the background.
    expect(await readStamp(INSTANCE_B, path, "remote"), "stale read on B").toBe(onA);
    await waitForChange(INSTANCE_B, path, "remote", onA);
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
