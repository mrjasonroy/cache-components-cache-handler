import { expect, test } from "@playwright/test";

test.describe("Tag-Based Revalidation (E2E-201-202)", () => {
  test("E2E-201: revalidateTag invalidates cached component", async ({ page }) => {
    // First visit - get initial timestamp
    await page.goto("/revalidate-test");
    const firstContent = await page.locator('[data-testid="tagged-content"]').textContent();

    // Wait a bit
    await page.waitForTimeout(200);

    // Refresh - should still be cached
    await page.reload();
    const cachedContent = await page.locator('[data-testid="tagged-content"]').textContent();
    expect(cachedContent).toBe(firstContent);

    // Click revalidate button
    await page.click('[data-testid="revalidate-button"]');

    // Wait for revalidation
    await page.waitForTimeout(500);

    // Reload page - should have new content
    await page.reload();
    const revalidatedContent = await page.locator('[data-testid="tagged-content"]').textContent();

    expect(revalidatedContent).not.toBe(firstContent);
  });

  test("E2E-202: updateTag immediate expiration", async ({ page }) => {
    // First visit - get initial timestamp
    await page.goto("/revalidate-test");
    const firstContent = await page.locator('[data-testid="tagged-content"]').textContent();

    // Wait a bit
    await page.waitForTimeout(200);

    // Click update button
    await page.click('[data-testid="update-button"]');

    // Wait for update
    await page.waitForTimeout(500);

    // Reload page - should have new content immediately
    await page.reload();
    const updatedContent = await page.locator('[data-testid="tagged-content"]').textContent();

    expect(updatedContent).not.toBe(firstContent);
  });
});
