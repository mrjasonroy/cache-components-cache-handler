import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

// Stable test ID for this describe block - all tests share it
const STABLE_TEST_ID = "cache-timing-test";

test.describe("Cache Timing Tests (Proof via Duration)", () => {
  test("slow DB query: 3s → <1s with cache", async ({ page }) => {
    // Use stable test ID via query param (doesn't block caching)
    const testId = STABLE_TEST_ID;

    // First load: Should take 3+ seconds
    const start1 = Date.now();
    await page.goto(`http://localhost:3000/slow-db?testId=${testId}`);
    await page.waitForSelector('[data-testid="db-content"]');
    const duration1 = Date.now() - start1;

    console.log(`First load: ${duration1}ms`);
    expect(duration1).toBeGreaterThan(3000); // 3s DB query

    // Verify stable test ID
    const userId1 = await page.locator('[data-testid="user-id"]').textContent();
    expect(userId1).toContain(testId);

    const timestamp1 = await page.locator('[data-testid="timestamp"]').textContent();

    // Second load: Should be < 1s (cached!)
    const start2 = Date.now();
    await page.reload();
    await page.waitForSelector('[data-testid="db-content"]');
    const duration2 = Date.now() - start2;

    console.log(`Second load (cached): ${duration2}ms`);
    expect(duration2).toBeLessThan(1000); // Instant = cached!

    // Verify SAME test ID (cache hit)
    const userId2 = await page.locator('[data-testid="user-id"]').textContent();
    expect(userId2).toBe(userId1);

    // Verify SAME timestamp (proves it's cached data)
    const timestamp2 = await page.locator('[data-testid="timestamp"]').textContent();
    expect(timestamp2).toBe(timestamp1);
  });

  test("revalidateTag: cached → 3s after invalidation", async ({ page }) => {
    const testId = STABLE_TEST_ID;

    // First load: 3s
    await page.goto(`http://localhost:3000/slow-db?testId=${testId}`);
    await page.waitForSelector('[data-testid="db-content"]');
    const timestamp1 = await page.locator('[data-testid="timestamp"]').textContent();

    // Second load: <1s (cached)
    const start2 = Date.now();
    await page.reload();
    await page.waitForSelector('[data-testid="db-content"]');
    expect(Date.now() - start2).toBeLessThan(1000);

    const timestamp2 = await page.locator('[data-testid="timestamp"]').textContent();
    expect(timestamp2).toBe(timestamp1); // Same = cached

    // Revalidate the tag
    await page.request.post("http://localhost:3000/api/revalidate-tag", {
      data: { tag: "top-user" },
    });

    // Third load: 3s again (cache invalidated!)
    const start3 = Date.now();
    await page.reload();
    await page.waitForSelector('[data-testid="db-content"]');
    const duration3 = Date.now() - start3;

    console.log(`After revalidation: ${duration3}ms`);
    expect(duration3).toBeGreaterThan(3000); // Slow again!

    const timestamp3 = await page.locator('[data-testid="timestamp"]').textContent();
    expect(timestamp3).not.toBe(timestamp1); // Different = fresh data
  });

  test("parallel tests with different stable IDs", async ({ page: page1, browser }) => {
    // Test that parallel tests don't interfere
    const page2 = await (await browser.newContext()).newPage();

    const testId1 = `${STABLE_TEST_ID}-1`;
    const testId2 = `${STABLE_TEST_ID}-2`;

    // Load both pages in parallel with different test IDs
    await Promise.all([
      page1.goto(`http://localhost:3000/slow-db?testId=${testId1}`),
      page2.goto(`http://localhost:3000/slow-db?testId=${testId2}`),
    ]);

    // Verify each page has its own stable ID
    const userId1 = await page1.locator('[data-testid="user-id"]').textContent();
    const userId2 = await page2.locator('[data-testid="user-id"]').textContent();

    expect(userId1).toContain(testId1);
    expect(userId2).toContain(testId2);
    expect(userId1).not.toBe(userId2); // Different IDs

    await page2.close();
  });
});
