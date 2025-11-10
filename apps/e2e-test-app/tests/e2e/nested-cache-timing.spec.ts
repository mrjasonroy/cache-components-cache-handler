import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test.describe("Nested Cache Tests (Uncached Parent + Cached Child)", () => {
  test("cached child saves time even with uncached parent", async ({ page, context }) => {
    // Setup: Set stable test IDs
    const recordId = `record-${Date.now()}`;
    const scoresId = `scores-${Date.now()}`;
    const pageId = `page-${Date.now()}`;

    await Promise.all([
      context.request.post("http://localhost:3000/api/test-setup", {
        data: { testId: recordId, scenario: "live-record" },
      }),
      context.request.post("http://localhost:3000/api/test-setup", {
        data: { testId: scoresId, scenario: "live-scores" },
      }),
      context.request.post("http://localhost:3000/api/test-setup", {
        data: { testId: pageId, scenario: "live-page" },
      }),
    ]);

    // First load: max(2s page, 3s scores, 8s record) = 8s
    const start1 = Date.now();
    await page.goto("http://localhost:3000/live-game");
    await page.waitForSelector('[data-testid="record-section"]');
    const duration1 = Date.now() - start1;

    console.log(`First load: ${duration1}ms`);
    expect(duration1).toBeGreaterThan(3000);
    expect(duration1).toBeLessThan(6000); // Parallel execution with overhead

    // Get initial values
    const record1Id = await page.locator('[data-testid="record-id"]').textContent();
    const scores1Id = await page.locator('[data-testid="scores-id"]').textContent();
    const page1Id = await page.locator('[data-testid="page-id"]').textContent();

    expect(record1Id).toContain(recordId);
    expect(scores1Id).toContain(scoresId);
    expect(page1Id).toContain(pageId);

    const record1Timestamp = await page
      .locator('[data-testid="record-section"]')
      .locator("p")
      .filter({ hasText: "Timestamp:" })
      .textContent();

    // Second load: max(2s page, 3s scores, <1s cached record) = 3s
    // This proves TeamRecord is cached even though parent is not!
    const start2 = Date.now();
    await page.reload();
    await page.waitForSelector('[data-testid="record-section"]');
    const duration2 = Date.now() - start2;

    console.log(`Second load (record cached): ${duration2}ms`);
    expect(duration2).toBeGreaterThan(3000); // Page + scores still execute
    expect(duration2).toBeLessThan(5000); // But record is cached (saved 8s!)

    // IDs should be the same (stable test IDs)
    const record2Id = await page.locator('[data-testid="record-id"]').textContent();
    const scores2Id = await page.locator('[data-testid="scores-id"]').textContent();
    const page2Id = await page.locator('[data-testid="page-id"]').textContent();

    expect(record2Id).toBe(record1Id); // Same ID
    expect(scores2Id).toBe(scores1Id); // Same ID
    expect(page2Id).toBe(page1Id); // Same ID

    // Record timestamp should be SAME (cached)
    const record2Timestamp = await page
      .locator('[data-testid="record-section"]')
      .locator("p")
      .filter({ hasText: "Timestamp:" })
      .textContent();

    expect(record2Timestamp).toBe(record1Timestamp); // Cached!

    // Scores and page timestamps should be DIFFERENT (uncached)
    const scores1Timestamp = await page
      .locator('[data-testid="scores-section"]')
      .locator("p")
      .filter({ hasText: "Timestamp:" })
      .first()
      .textContent();

    await page.reload();
    await page.waitForSelector('[data-testid="record-section"]');

    const scores3Timestamp = await page
      .locator('[data-testid="scores-section"]')
      .locator("p")
      .filter({ hasText: "Timestamp:" })
      .first()
      .textContent();

    expect(scores3Timestamp).not.toBe(scores1Timestamp); // Fresh each time

    await context.request.post("http://localhost:3000/api/test-clear");
  });

  test("revalidating cached child makes it slow again", async ({ page, context }) => {
    const recordId = `record-${Date.now()}`;
    const scoresId = `scores-${Date.now()}`;
    const pageId = `page-${Date.now()}`;

    await Promise.all([
      context.request.post("http://localhost:3000/api/test-setup", {
        data: { testId: recordId, scenario: "live-record" },
      }),
      context.request.post("http://localhost:3000/api/test-setup", {
        data: { testId: scoresId, scenario: "live-scores" },
      }),
      context.request.post("http://localhost:3000/api/test-setup", {
        data: { testId: pageId, scenario: "live-page" },
      }),
    ]);

    // First load: 8s
    await page.goto("http://localhost:3000/live-game");
    await page.waitForSelector('[data-testid="record-section"]');

    // Second load: 3s (record cached)
    const start2 = Date.now();
    await page.reload();
    await page.waitForSelector('[data-testid="record-section"]');
    const duration2 = Date.now() - start2;

    console.log(`With cached record: ${duration2}ms`);
    expect(duration2).toBeGreaterThan(3000);
    expect(duration2).toBeLessThan(5000);

    // Revalidate team record
    await context.request.post("http://localhost:3000/api/revalidate-tag", {
      data: { tag: "team" },
    });

    // Third load: 8s again (record cache invalidated)
    const start3 = Date.now();
    await page.reload();
    await page.waitForSelector('[data-testid="record-section"]');
    const duration3 = Date.now() - start3;

    console.log(`After revalidating team tag: ${duration3}ms`);
    expect(duration3).toBeGreaterThan(3000); // Record refetching
    expect(duration3).toBeLessThan(6000); // With overhead

    await context.request.post("http://localhost:3000/api/test-clear");
  });
});
