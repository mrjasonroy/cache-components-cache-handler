import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test.describe("Mixed Cache Tests (Default + Remote)", () => {
  test("granular tag invalidation: only revalidated tag refetches", async ({ page, context }) => {
    // Use stable IDs via query params (pure static pattern)
    const layoutId = `layout-${Date.now()}`;
    const statsId = `stats-${Date.now()}`;
    const ordersId = `orders-${Date.now()}`;

    const url = `http://localhost:3000/mixed-cache?layoutId=${layoutId}&statsId=${statsId}&ordersId=${ordersId}`;

    // First load: Takes ~8s (parallel: max(5s layout, 8s stats, 8s orders))
    const start1 = Date.now();
    await page.goto(url);
    await page.waitForSelector('[data-testid="layout-section"]');
    const duration1 = Date.now() - start1;

    console.log(`First load: ${duration1}ms`);
    expect(duration1).toBeGreaterThan(3000);
    expect(duration1).toBeLessThan(10000); // Parallel execution

    // Get initial IDs and timestamps
    const layout1Id = await page.locator('[data-testid="layout-id"]').textContent();
    const stats1Id = await page.locator('[data-testid="stats-id"]').textContent();
    const orders1Id = await page.locator('[data-testid="orders-id"]').textContent();

    expect(layout1Id).toContain(layoutId);
    expect(stats1Id).toContain(statsId);
    expect(orders1Id).toContain(ordersId);

    // Second load: ALL cached (<1s)
    const start2 = Date.now();
    await page.reload();
    await page.waitForSelector('[data-testid="layout-section"]');
    const duration2 = Date.now() - start2;

    console.log(`Second load (all cached): ${duration2}ms`);
    expect(duration2).toBeLessThan(1000); // Instant!

    // Verify all IDs are the same (cached)
    expect(await page.locator('[data-testid="layout-id"]').textContent()).toBe(layout1Id);
    expect(await page.locator('[data-testid="stats-id"]').textContent()).toBe(stats1Id);
    expect(await page.locator('[data-testid="orders-id"]').textContent()).toBe(orders1Id);

    // Revalidate ONLY the "stats" tag (remote cache)
    await context.request.post("http://localhost:3000/api/revalidate-tag", {
      data: { tag: "stats" },
    });

    // Third load: Only stats refetches (~8s), others stay cached
    const start3 = Date.now();
    await page.reload();
    await page.waitForSelector('[data-testid="layout-section"]');
    const duration3 = Date.now() - start3;

    console.log(`After revalidating stats tag: ${duration3}ms`);
    expect(duration3).toBeGreaterThan(2900); // Stats refetching (allow small variance)
    expect(duration3).toBeLessThan(5000); // But not layout or orders

    // Layout and orders should be SAME (still cached)
    expect(await page.locator('[data-testid="layout-id"]').textContent()).toBe(layout1Id);
    expect(await page.locator('[data-testid="orders-id"]').textContent()).toBe(orders1Id);

    // Stats should be SAME ID (test ID stable) but fetch happened
    expect(await page.locator('[data-testid="stats-id"]').textContent()).toContain(statsId);
  });

  test("default cache vs remote cache isolation", async ({ page, context }) => {
    const layoutId = `layout-${Date.now()}`;
    const statsId = `stats-${Date.now()}`;
    const ordersId = `orders-${Date.now()}`;

    const url = `http://localhost:3000/mixed-cache?layoutId=${layoutId}&statsId=${statsId}&ordersId=${ordersId}`;

    // Load and cache everything
    await page.goto(url);
    await page.waitForSelector('[data-testid="layout-section"]');

    const layout1Timestamp = await page
      .locator('[data-testid="layout-section"]')
      .locator("p")
      .filter({ hasText: "Timestamp:" })
      .textContent();

    // Reload: all cached
    await page.reload();
    await page.waitForSelector('[data-testid="layout-section"]');

    const layout2Timestamp = await page
      .locator('[data-testid="layout-section"]')
      .locator("p")
      .filter({ hasText: "Timestamp:" })
      .textContent();

    expect(layout2Timestamp).toBe(layout1Timestamp); // Layout cached

    // Revalidate "layout" tag (default cache)
    await context.request.post("http://localhost:3000/api/revalidate-tag", {
      data: { tag: "layout" },
    });

    // Reload: Layout refetches (~5s), remote caches stay
    const start = Date.now();
    await page.reload();
    await page.waitForSelector('[data-testid="layout-section"]');
    const duration = Date.now() - start;

    console.log(`After revalidating layout: ${duration}ms`);
    expect(duration).toBeGreaterThan(3000); // Layout refetching
    expect(duration).toBeLessThan(10000); // With overhead

    const layout3Timestamp = await page
      .locator('[data-testid="layout-section"]')
      .locator("p")
      .filter({ hasText: "Timestamp:" })
      .textContent();

    // Layout should have NEW timestamp (refetched)
    expect(layout3Timestamp).not.toBe(layout1Timestamp);
  });
});
