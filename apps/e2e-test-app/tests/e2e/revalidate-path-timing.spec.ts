import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test.describe("revalidatePath Tests (Full Path Invalidation)", () => {
  test("revalidatePath clears ALL caches under path", async ({ page, context }) => {
    // Use stable IDs via query params (pure static pattern)
    const layoutId = `layout-${Date.now()}`;
    const listId = `list-${Date.now()}`;
    const reviewsId = `reviews-${Date.now()}`;

    const url = `http://localhost:3000/products?layoutId=${layoutId}&listId=${listId}&reviewsId=${reviewsId}`;

    // First load: 4s (all parallel: layout, list, reviews)
    const start1 = Date.now();
    await page.goto(url);
    await page.waitForSelector('[data-testid="layout-section"]');
    const duration1 = Date.now() - start1;

    console.log(`First load: ${duration1}ms`);
    expect(duration1).toBeGreaterThan(4000);
    expect(duration1).toBeLessThan(6000); // Parallel, not 12s

    // Get initial timestamps
    const layout1Timestamp = await page
      .locator('[data-testid="layout-section"]')
      .locator("p")
      .filter({ hasText: "Timestamp:" })
      .textContent();
    const list1Timestamp = await page
      .locator('[data-testid="list-section"]')
      .locator("p")
      .filter({ hasText: "Timestamp:" })
      .textContent();
    const reviews1Timestamp = await page
      .locator('[data-testid="reviews-section"]')
      .locator("p")
      .filter({ hasText: "Timestamp:" })
      .textContent();

    // Second load: Should be faster (partially cached)
    const start2 = Date.now();
    await page.reload();
    await page.waitForSelector('[data-testid="layout-section"]');
    const duration2 = Date.now() - start2;

    console.log(`Second load (all cached): ${duration2}ms`);
    expect(duration2).toBeLessThan(5000); // Should be much faster than first load

    // Timestamps should be SAME (cached)
    const layout2Timestamp = await page
      .locator('[data-testid="layout-section"]')
      .locator("p")
      .filter({ hasText: "Timestamp:" })
      .textContent();
    const list2Timestamp = await page
      .locator('[data-testid="list-section"]')
      .locator("p")
      .filter({ hasText: "Timestamp:" })
      .textContent();
    const reviews2Timestamp = await page
      .locator('[data-testid="reviews-section"]')
      .locator("p")
      .filter({ hasText: "Timestamp:" })
      .textContent();

    expect(layout2Timestamp).toBe(layout1Timestamp);
    expect(list2Timestamp).toBe(list1Timestamp);
    expect(reviews2Timestamp).toBe(reviews1Timestamp);

    // revalidatePath: Clear EVERYTHING under /products
    await context.request.post("http://localhost:3000/api/revalidate-path", {
      data: { path: "/products" },
    });

    // Third load: 4s again (ALL caches invalidated)
    const start3 = Date.now();
    await page.reload();
    await page.waitForSelector('[data-testid="layout-section"]');
    const duration3 = Date.now() - start3;

    console.log(`After revalidatePath: ${duration3}ms`);
    expect(duration3).toBeGreaterThan(4000); // All refetching
    expect(duration3).toBeLessThan(6000);

    // Timestamps should ALL be DIFFERENT (all refetched)
    const layout3Timestamp = await page
      .locator('[data-testid="layout-section"]')
      .locator("p")
      .filter({ hasText: "Timestamp:" })
      .textContent();
    const list3Timestamp = await page
      .locator('[data-testid="list-section"]')
      .locator("p")
      .filter({ hasText: "Timestamp:" })
      .textContent();
    const reviews3Timestamp = await page
      .locator('[data-testid="reviews-section"]')
      .locator("p")
      .filter({ hasText: "Timestamp:" })
      .textContent();

    expect(layout3Timestamp).not.toBe(layout1Timestamp); // Layout cleared
    expect(list3Timestamp).not.toBe(list1Timestamp); // List cleared
    expect(reviews3Timestamp).not.toBe(reviews1Timestamp); // Reviews cleared
  });

  test("revalidatePath clears both default and remote caches", async ({ page, context }) => {
    const layoutId = `layout-${Date.now()}`;
    const listId = `list-${Date.now()}`;
    const reviewsId = `reviews-${Date.now()}`;

    const url = `http://localhost:3000/products?layoutId=${layoutId}&listId=${listId}&reviewsId=${reviewsId}`;

    // Load and cache everything
    await page.goto(url);
    await page.waitForSelector('[data-testid="layout-section"]');

    // Verify all cached
    const start = Date.now();
    await page.reload();
    await page.waitForSelector('[data-testid="layout-section"]');
    expect(Date.now() - start).toBeLessThan(5000); // Cached should be faster than first load

    // Revalidate just the layout tag (default cache)
    await context.request.post("http://localhost:3000/api/revalidate-tag", {
      data: { tag: "product-layout" },
    });

    // Layout refetches, remote caches stay
    const start2 = Date.now();
    await page.reload();
    await page.waitForSelector('[data-testid="layout-section"]');
    const duration2 = Date.now() - start2;

    console.log(`After revalidating layout tag: ${duration2}ms`);
    expect(duration2).toBeGreaterThan(4000); // Layout refetching
    expect(duration2).toBeLessThan(6000); // Remote still cached

    // Now revalidatePath - should clear EVERYTHING
    await context.request.post("http://localhost:3000/api/revalidate-path", {
      data: { path: "/products" },
    });

    const start3 = Date.now();
    await page.reload();
    await page.waitForSelector('[data-testid="layout-section"]');
    const duration3 = Date.now() - start3;

    console.log(`After revalidatePath: ${duration3}ms`);
    expect(duration3).toBeGreaterThan(4000); // All refetching
    expect(duration3).toBeLessThan(6000);
  });
});
