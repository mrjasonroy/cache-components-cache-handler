import { expect, test } from "@playwright/test";

test.describe("Basic Caching (E2E-001-003)", () => {
  test("E2E-001: use cache in async Server Component", async ({ page }) => {
    const testId = `component-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // First visit
    await page.goto(`/cached-component?id=${testId}`);
    const firstTimestamp = await page.locator('[data-testid="cached-content"]').textContent();

    // Wait a bit
    await page.waitForTimeout(200);

    // Refresh the page
    await page.reload();

    // Second visit - should show same timestamp (cached)
    const secondTimestamp = await page.locator('[data-testid="cached-content"]').textContent();

    expect(firstTimestamp).toBe(secondTimestamp);
  });

  test("E2E-002: use cache in page component", async ({ page }) => {
    const testId = `page-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // First visit
    await page.goto(`/cached-page?id=${testId}`);
    const firstContent = await page.locator('[data-testid="cached-page-content"]').textContent();

    // Wait a bit
    await page.waitForTimeout(200);

    // Refresh the page
    await page.reload();

    // Second visit - should show same content (cached)
    const secondContent = await page.locator('[data-testid="cached-page-content"]').textContent();

    expect(firstContent).toBe(secondContent);
  });

  test("E2E-003: use cache in async utility function", async ({ page }) => {
    const testId = `function-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    await page.goto(`/cached-function?id=${testId}`);

    // Verify that both function calls returned the same values
    const matchText = await page.locator('[data-testid="values-match"]').textContent();

    expect(matchText).toContain("YES");
  });
});
