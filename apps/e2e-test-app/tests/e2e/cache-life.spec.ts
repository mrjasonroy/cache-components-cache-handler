import { expect, test } from "@playwright/test";

test.describe("cacheLife() API Tests", () => {
  test.describe("Preset Profiles", () => {
    test("default profile: caches and serves cached content", async ({ page }) => {
      const testId = `default-${Date.now()}`;

      // First load
      await page.goto(`/cache-life-test?profile=default&id=${testId}`);
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

    test("'seconds' profile: caches content", async ({ page }) => {
      const testId = `seconds-${Date.now()}`;

      // First load
      await page.goto(`/cache-life-test?profile=seconds&id=${testId}`);
      const timestamp1 = await page.locator('[data-testid="timestamp"]').textContent();

      // Second load - should be cached
      await page.reload();
      const timestamp2 = await page.locator('[data-testid="timestamp"]').textContent();

      expect(timestamp2).toBe(timestamp1);
    });

    test("'minutes' profile: caches content", async ({ page }) => {
      const testId = `minutes-${Date.now()}`;

      await page.goto(`/cache-life-test?profile=minutes&id=${testId}`);
      const timestamp1 = await page.locator('[data-testid="timestamp"]').textContent();

      await page.reload();
      const timestamp2 = await page.locator('[data-testid="timestamp"]').textContent();

      expect(timestamp2).toBe(timestamp1);
    });

    test("'hours' profile: caches content", async ({ page }) => {
      const testId = `hours-${Date.now()}`;

      await page.goto(`/cache-life-test?profile=hours&id=${testId}`);
      const timestamp1 = await page.locator('[data-testid="timestamp"]').textContent();

      await page.reload();
      const timestamp2 = await page.locator('[data-testid="timestamp"]').textContent();

      expect(timestamp2).toBe(timestamp1);
    });

    test("'days' profile: caches content", async ({ page }) => {
      const testId = `days-${Date.now()}`;

      await page.goto(`/cache-life-test?profile=days&id=${testId}`);
      const timestamp1 = await page.locator('[data-testid="timestamp"]').textContent();

      await page.reload();
      const timestamp2 = await page.locator('[data-testid="timestamp"]').textContent();

      expect(timestamp2).toBe(timestamp1);
    });

    test("'weeks' profile: caches content", async ({ page }) => {
      const testId = `weeks-${Date.now()}`;

      await page.goto(`/cache-life-test?profile=weeks&id=${testId}`);
      const timestamp1 = await page.locator('[data-testid="timestamp"]').textContent();

      await page.reload();
      const timestamp2 = await page.locator('[data-testid="timestamp"]').textContent();

      expect(timestamp2).toBe(timestamp1);
    });

    test("'max' profile: caches content", async ({ page }) => {
      const testId = `max-${Date.now()}`;

      await page.goto(`/cache-life-test?profile=max&id=${testId}`);
      const timestamp1 = await page.locator('[data-testid="timestamp"]').textContent();

      await page.reload();
      const timestamp2 = await page.locator('[data-testid="timestamp"]').textContent();

      expect(timestamp2).toBe(timestamp1);
    });
  });

  test.describe("Custom Profiles", () => {
    test("custom 'biweekly' profile from next.config: caches content", async ({ page }) => {
      const testId = `biweekly-${Date.now()}`;

      await page.goto(`/cache-life-test?profile=biweekly&id=${testId}`);
      const timestamp1 = await page.locator('[data-testid="timestamp"]').textContent();

      await page.reload();
      const timestamp2 = await page.locator('[data-testid="timestamp"]').textContent();

      expect(timestamp2).toBe(timestamp1);
    });

    test("custom 'short' profile from next.config: caches content", async ({ page }) => {
      const testId = `short-${Date.now()}`;

      await page.goto(`/cache-life-test?profile=short&id=${testId}`);
      const timestamp1 = await page.locator('[data-testid="timestamp"]').textContent();

      await page.reload();
      const timestamp2 = await page.locator('[data-testid="timestamp"]').textContent();

      expect(timestamp2).toBe(timestamp1);
    });
  });

  test.describe("Inline Profiles", () => {
    test("inline profile object: caches content", async ({ page }) => {
      const testId = `inline-${Date.now()}`;

      await page.goto(`/cache-life-test?profile=inline&id=${testId}`);
      const timestamp1 = await page.locator('[data-testid="timestamp"]').textContent();

      await page.reload();
      const timestamp2 = await page.locator('[data-testid="timestamp"]').textContent();

      expect(timestamp2).toBe(timestamp1);
    });
  });

  test.describe("Cache Isolation", () => {
    test("same ID with same profile uses cache", async ({ page }) => {
      const testId = `same-id-${Date.now()}`;

      // Load with 'hours' profile
      await page.goto(`/cache-life-test?profile=hours&id=${testId}`);
      const timestamp1 = await page.locator('[data-testid="timestamp"]').textContent();

      // Load again with same profile and ID
      await page.goto(`/cache-life-test?profile=hours&id=${testId}`);
      const timestamp2 = await page.locator('[data-testid="timestamp"]').textContent();

      // Should be same (cached)
      expect(timestamp2).toBe(timestamp1);
    });
  });

  test.describe("Cache Persistence", () => {
    test("cached content persists across multiple page loads", async ({ page }) => {
      const testId = `persistence-${Date.now()}`;

      await page.goto(`/cache-life-test?profile=days&id=${testId}`);
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
