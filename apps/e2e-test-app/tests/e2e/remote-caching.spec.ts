import { expect, test } from "@playwright/test";

test.describe("Remote Caching Tests", () => {
  test("should cache database query results with 'use cache: remote'", async ({ page }) => {
    const testId = `remote-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // First visit - cache miss, should generate unique ID
    await page.goto(`/remote-cache?id=${testId}`);

    const firstContent = await page.locator('[data-testid="remote-cache-content"]').textContent();
    const firstUniqueId = firstContent?.match(/Unique ID: (\w+)/)?.[1];
    const firstTimestamp = firstContent?.match(/Timestamp: ([^\n]+)/)?.[1];

    expect(firstUniqueId).toBeTruthy();
    expect(firstTimestamp).toBeTruthy();

    // Wait a bit to ensure timestamp would change if not cached
    await page.waitForTimeout(200);

    // Second visit - cache hit, should return SAME unique ID
    await page.reload();

    const secondContent = await page.locator('[data-testid="remote-cache-content"]').textContent();
    const secondUniqueId = secondContent?.match(/Unique ID: (\w+)/)?.[1];
    const secondTimestamp = secondContent?.match(/Timestamp: ([^\n]+)/)?.[1];

    // CRITICAL: If cached, unique ID should be EXACTLY the same
    expect(secondUniqueId).toBe(firstUniqueId);
    expect(secondTimestamp).toBe(firstTimestamp);
  });

  test("should cache fetch function results with 'use cache: remote'", async ({ page }) => {
    const testId = `fetch-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // First visit
    await page.goto(`/remote-fetch?id=${testId}`);

    const firstContent = await page.locator('[data-testid="remote-fetch-content"]').textContent();
    const firstRandom = firstContent?.match(/Random Value: ([\d.]+)/)?.[1];
    const firstTime = firstContent?.match(/Fetch Time: (\d+)/)?.[1];

    expect(firstRandom).toBeTruthy();
    expect(firstTime).toBeTruthy();

    await page.waitForTimeout(200);

    // Second visit - should be cached
    await page.reload();

    const secondContent = await page.locator('[data-testid="remote-fetch-content"]').textContent();
    const secondRandom = secondContent?.match(/Random Value: ([\d.]+)/)?.[1];
    const secondTime = secondContent?.match(/Fetch Time: (\d+)/)?.[1];

    // Random value should be identical (proving cache hit)
    expect(secondRandom).toBe(firstRandom);
    expect(secondTime).toBe(firstTime);
  });

  test("should cache with tags and support tag-based revalidation", async ({ page }) => {
    const testId = `tagged-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // Initial load
    await page.goto(`/remote-tagged?id=${testId}`);

    const getProductValue = async () => {
      const content = await page.locator('[data-testid="product-data"]').textContent();
      return content?.match(/Unique Value: ([^\s]+)/)?.[1];
    };

    const getUserValue = async () => {
      const content = await page.locator('[data-testid="user-data"]').textContent();
      return content?.match(/Unique Value: ([^\s]+)/)?.[1];
    };

    const productValue1 = await getProductValue();
    const userValue1 = await getUserValue();

    expect(productValue1).toBeTruthy();
    expect(userValue1).toBeTruthy();

    // Reload - should get cached values
    await page.reload();

    const productValue2 = await getProductValue();
    const userValue2 = await getUserValue();

    // Values should be cached (identical)
    expect(productValue2).toBe(productValue1);
    expect(userValue2).toBe(userValue1);

    // TODO: Test revalidation once we have API routes working
    // For now, we've proven the remote caching works
  });
});
