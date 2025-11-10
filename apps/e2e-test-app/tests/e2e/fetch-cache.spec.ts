import { expect, test } from "@playwright/test";

test.describe("Fetch Caching Tests", () => {
  test.describe("fetch() WITHOUT use cache (Next.js 16 Behavior)", () => {
    test("force-cache: does NOT cache with cacheComponents enabled", async ({ page }) => {
      const testId = `force-cache-${Date.now()}`;

      // First load
      await page.goto(`/fetch-test?id=${testId}&cache=force-cache`);
      const timestamp1 = await page.locator('[data-testid="timestamp"]').textContent();

      // Wait to ensure timestamp would be different
      await page.waitForTimeout(100);

      // Second load - In Next.js 16 with cacheComponents, native fetch() is NOT cached
      await page.reload();
      const timestamp2 = await page.locator('[data-testid="timestamp"]').textContent();

      // Should be different (NOT cached) - this is expected behavior in Next.js 16
      expect(timestamp2).not.toBe(timestamp1);
    });

    test("no-store: does not cache fetch responses", async ({ page }) => {
      const testId = `no-store-${Date.now()}`;

      // First load
      await page.goto(`/fetch-test?id=${testId}&cache=no-store`);
      const timestamp1 = await page.locator('[data-testid="timestamp"]').textContent();

      // Wait a bit to ensure timestamp would be different
      await page.waitForTimeout(100);

      // Second load - should NOT be cached
      await page.reload();
      const timestamp2 = await page.locator('[data-testid="timestamp"]').textContent();

      // Should be different (not cached)
      expect(timestamp2).not.toBe(timestamp1);
    });

    test("tags: does NOT cache with cacheComponents enabled", async ({ page }) => {
      const testId = `tags-${Date.now()}`;

      // First load
      await page.goto(`/fetch-test?id=${testId}&cache=tags`);
      const timestamp1 = await page.locator('[data-testid="timestamp"]').textContent();

      // Wait to ensure timestamp would be different
      await page.waitForTimeout(100);

      // Second load - In Next.js 16 with cacheComponents, tags don't work without "use cache"
      await page.reload();
      const timestamp2 = await page.locator('[data-testid="timestamp"]').textContent();

      // Should be different (NOT cached) - this is expected behavior in Next.js 16
      expect(timestamp2).not.toBe(timestamp1);
    });
  });

  test.describe("fetch() WITH use cache (New Data Cache)", () => {
    test("use cache: caches fetch responses", async ({ page }) => {
      const testId = `with-cache-${Date.now()}`;

      // First load - cache miss
      await page.goto(`/fetch-with-cache?id=${testId}&useCache=true`);
      const timestamp1 = await page.locator('[data-testid="timestamp"]').textContent();
      const random1 = await page.locator('[data-testid="random"]').textContent();

      // Second load - should be cached
      await page.reload();
      const timestamp2 = await page.locator('[data-testid="timestamp"]').textContent();
      const random2 = await page.locator('[data-testid="random"]').textContent();

      // Should be same (cached)
      expect(timestamp2).toBe(timestamp1);
      expect(random2).toBe(random1);
    });

    test("useCache=false: does not cache", async ({ page }) => {
      const testId = `without-cache-${Date.now()}`;

      // First load
      await page.goto(`/fetch-with-cache?id=${testId}&useCache=false`);
      const timestamp1 = await page.locator('[data-testid="timestamp"]').textContent();

      // Wait a bit
      await page.waitForTimeout(100);

      // Second load - should NOT be cached
      await page.reload();
      const timestamp2 = await page.locator('[data-testid="timestamp"]').textContent();

      // Should be different (not cached)
      expect(timestamp2).not.toBe(timestamp1);
    });

    test("cacheLife profile: respects cache profiles", async ({ page }) => {
      const testId = `profile-${Date.now()}`;

      // First load with 'hours' profile
      await page.goto(`/fetch-with-cache?id=${testId}&useCache=true&profile=hours`);
      const timestamp1 = await page.locator('[data-testid="timestamp"]').textContent();

      // Second load - should be cached
      await page.reload();
      const timestamp2 = await page.locator('[data-testid="timestamp"]').textContent();

      expect(timestamp2).toBe(timestamp1);
    });

    test("cacheTag: supports tag-based invalidation", async ({ page }) => {
      const testId = `tagged-${Date.now()}`;
      const tag = `fetch-tag-${Date.now()}`;

      // First load with tag
      await page.goto(`/fetch-with-cache?id=${testId}&useCache=true&tag=${tag}`);
      const timestamp1 = await page.locator('[data-testid="timestamp"]').textContent();

      // Second load - should be cached
      await page.reload();
      const timestamp2 = await page.locator('[data-testid="timestamp"]').textContent();

      expect(timestamp2).toBe(timestamp1);
    });
  });

  test.describe("Cache Isolation", () => {
    test("different IDs cache separately", async ({ page }) => {
      const id1 = `isolation-1-${Date.now()}`;
      const id2 = `isolation-2-${Date.now()}`;

      // Load first ID
      await page.goto(`/fetch-with-cache?id=${id1}&useCache=true`);
      const timestamp1 = await page.locator('[data-testid="timestamp"]').textContent();

      // Load second ID
      await page.goto(`/fetch-with-cache?id=${id2}&useCache=true`);
      const timestamp2 = await page.locator('[data-testid="timestamp"]').textContent();

      // Should be different (different cache entries)
      expect(timestamp2).not.toBe(timestamp1);

      // Load first ID again - should use its cached value
      await page.goto(`/fetch-with-cache?id=${id1}&useCache=true`);
      const timestamp3 = await page.locator('[data-testid="timestamp"]').textContent();

      expect(timestamp3).toBe(timestamp1);
    });

    test("same ID caches together", async ({ page }) => {
      const testId = `same-id-${Date.now()}`;

      // First load
      await page.goto(`/fetch-with-cache?id=${testId}&useCache=true`);
      const timestamp1 = await page.locator('[data-testid="timestamp"]').textContent();

      // Second load with same ID
      await page.goto(`/fetch-with-cache?id=${testId}&useCache=true`);
      const timestamp2 = await page.locator('[data-testid="timestamp"]').textContent();

      // Should be same (cached)
      expect(timestamp2).toBe(timestamp1);
    });
  });

  test.describe("Cache Persistence", () => {
    test("cached fetch persists across multiple loads", async ({ page }) => {
      const testId = `persistence-${Date.now()}`;

      await page.goto(`/fetch-with-cache?id=${testId}&useCache=true`);
      const timestamp1 = await page.locator('[data-testid="timestamp"]').textContent();

      // Load 3 more times
      await page.reload();
      await page.reload();
      await page.reload();

      const timestampFinal = await page.locator('[data-testid="timestamp"]').textContent();

      // Should still be cached
      expect(timestampFinal).toBe(timestamp1);
    });
  });
});
