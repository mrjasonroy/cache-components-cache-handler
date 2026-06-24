import { type Page, expect, test } from "@playwright/test";
import { PAYLOAD_ITEM_COUNT, PAYLOAD_UNICODE } from "../../lib/large-payload";

const SUMMARY = '[data-testid="payload-summary"]';

/**
 * Polls (settle + reload + compare) until two consecutive loads match, proving
 * the payload is served from cache rather than re-generated. Mirrors the
 * condition-based pattern used by the revalidation specs.
 */
async function waitForCachedSummary(page: Page): Promise<string> {
  let cached = "";
  await expect(async () => {
    const before = await page.locator(SUMMARY).textContent();
    await page.waitForTimeout(500);
    await page.reload();
    const after = await page.locator(SUMMARY).textContent();
    expect(after).toBe(before);
    cached = after ?? "";
  }).toPass({ timeout: 20_000, intervals: [500, 1000] });
  return cached;
}

test.describe("Large Payload Serialization (E2E-301)", () => {
  test("E2E-301: large, nested, unicode payload round-trips through the cache intact", async ({
    page,
  }) => {
    await page.goto("/payload-test");

    // The content must stabilize across reloads (served from cache).
    await waitForCachedSummary(page);

    // All fields survive the cache serialization round-trip.
    await expect(page.locator('[data-testid="payload-count"]')).toHaveText(
      `Count: ${PAYLOAD_ITEM_COUNT}`,
    );
    await expect(page.locator('[data-testid="payload-unicode"]')).toHaveText(
      `Unicode: ${PAYLOAD_UNICODE}`,
    );
    await expect(page.locator('[data-testid="payload-first"]')).toHaveText(
      `First: Item 0 — ${PAYLOAD_UNICODE}`,
    );
    await expect(page.locator('[data-testid="payload-last"]')).toHaveText(
      `Last: Item ${PAYLOAD_ITEM_COUNT - 1} — ${PAYLOAD_UNICODE}`,
    );
    // Deeply-nested values are preserved.
    await expect(page.locator('[data-testid="payload-nested"]')).toHaveText(
      `Nested: ${(PAYLOAD_ITEM_COUNT - 1) * 2}/tag-${PAYLOAD_ITEM_COUNT - 1},tag-${PAYLOAD_ITEM_COUNT}`,
    );
  });

  test("E2E-301b: cached payload stays byte-identical across reloads", async ({ page }) => {
    await page.goto("/payload-test");

    const cached = await waitForCachedSummary(page);

    // Two more reloads must return exactly the same content (stable cache hit).
    await page.reload();
    expect(await page.locator(SUMMARY).textContent()).toBe(cached);
    await page.reload();
    expect(await page.locator(SUMMARY).textContent()).toBe(cached);
  });
});
