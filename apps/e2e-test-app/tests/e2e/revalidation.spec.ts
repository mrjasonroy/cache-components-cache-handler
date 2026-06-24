import { type Page, expect, test } from "@playwright/test";

const CONTENT = '[data-testid="tagged-content"]';

/**
 * Returns the cached content once caching has demonstrably stabilized.
 *
 * The cached component embeds a timestamp + Math.random(), so it only stays
 * identical across reloads when it is actually served from cache. The first
 * render is a cold miss whose `"use cache"` write commits asynchronously with
 * no client-observable signal, so we let the write settle, then reload and
 * compare. `toPass` retries the whole cycle until two consecutive loads match,
 * which removes the race that made a single fixed-timeout reload flaky.
 */
async function waitForCachedContent(page: Page): Promise<string> {
  let cached = "";
  await expect(async () => {
    const before = await page.locator(CONTENT).textContent();
    // Give the asynchronous cache write from this render time to commit before
    // reloading; otherwise the next load is another cold miss.
    await page.waitForTimeout(500);
    await page.reload();
    const after = await page.locator(CONTENT).textContent();
    expect(after).toBe(before);
    cached = after ?? "";
  }).toPass({ timeout: 20_000, intervals: [500, 1000] });
  return cached;
}

/**
 * Reloads until the content differs from `previous`, proving the invalidation
 * took effect. Avoids a fixed wait that may be too short (test flakes) or
 * needlessly long.
 */
async function waitForChangedContent(page: Page, previous: string): Promise<void> {
  await expect(async () => {
    await page.reload();
    const current = await page.locator(CONTENT).textContent();
    expect(current).not.toBe(previous);
  }).toPass({ timeout: 20_000, intervals: [500, 1000] });
}

test.describe("Tag-Based Revalidation (E2E-201-202)", () => {
  // Each test uses its own tag so invalidating one cannot affect the other.
  test("E2E-201: revalidateTag invalidates cached component", async ({ page }) => {
    await page.goto("/revalidate-test?tag=e2e-201-revalidate");

    // Establish a confirmed-cached baseline (stable across reloads).
    const cachedContent = await waitForCachedContent(page);

    // Invalidate by tag, then confirm the content changes.
    await page.click('[data-testid="revalidate-button"]');
    await waitForChangedContent(page, cachedContent);
  });

  test("E2E-202: updateTag immediate expiration", async ({ page }) => {
    await page.goto("/revalidate-test?tag=e2e-202-update");

    // Establish a confirmed-cached baseline (stable across reloads).
    const cachedContent = await waitForCachedContent(page);

    // updateTag should expire the entry, so the next load changes.
    await page.click('[data-testid="update-button"]');
    await waitForChangedContent(page, cachedContent);
  });
});
