import { expect, test } from "@playwright/test";

test.describe("Suspense Boundary Tests (E2E-101)", () => {
  test("E2E-101: Cached component WITH Suspense boundary", async ({ page }) => {
    const testId = `suspense-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    await page.goto(`/suspense-with?id=${testId}`);

    // Should either show loading or content, but no error
    const hasLoading = await page.locator('[data-testid="loading"]').count();
    const hasContent = await page.locator('[data-testid="dynamic-content"]').count();

    expect(hasLoading + hasContent).toBeGreaterThan(0);

    // Wait for content to load
    if (hasLoading > 0) {
      await page.waitForSelector('[data-testid="dynamic-content"]', {
        timeout: 5000,
      });
    }

    // Verify content is present
    await expect(page.locator('[data-testid="dynamic-content"]')).toBeVisible();
  });
});
