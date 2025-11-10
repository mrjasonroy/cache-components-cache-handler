import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test.describe("Dynamic Suspense Tests (Static Shell + Dynamic Content)", () => {
  test("static header caches, user session always fresh", async ({ page, context }) => {
    // Setup stable IDs
    const sessionId = `session-${Date.now()}`;
    const prefsId = `prefs-${Date.now()}`;

    await Promise.all([
      context.request.post("http://localhost:3000/api/test-setup", {
        data: { testId: sessionId, scenario: "user-session" },
      }),
      context.request.post("http://localhost:3000/api/test-setup", {
        data: { testId: prefsId, scenario: "user-prefs" },
      }),
    ]);

    // First load: header (3s) + session (2s) + prefs (3s)
    // Suspense boundaries may stream in parallel or sequentially depending on conditions
    // Parallel: ~3s (max of all), Sequential: ~8s (sum of all)
    const start1 = Date.now();
    await page.goto("http://localhost:3000/dynamic-suspense");
    await page.waitForSelector('[data-testid="static-header"]');
    await page.waitForSelector('[data-testid="user-section"]');
    await page.waitForSelector('[data-testid="prefs-section"]');
    const duration1 = Date.now() - start1;

    console.log(`First load: ${duration1}ms`);
    expect(duration1).toBeGreaterThan(3000); // At minimum, slowest component (3s)
    expect(duration1).toBeLessThan(10000); // With overhead, could be sequential

    // Get initial timestamps
    const header1Timestamp = await page.locator('[data-testid="header-timestamp"]').textContent();
    const user1Timestamp = await page.locator('[data-testid="user-timestamp"]').textContent();
    const prefs1Timestamp = await page.locator('[data-testid="prefs-timestamp"]').textContent();

    // Second load: header (<1s cached) + session (2s fresh) + prefs (<1s cached) = ~2-3s
    const start2 = Date.now();
    await page.reload();
    await page.waitForSelector('[data-testid="static-header"]');
    await page.waitForSelector('[data-testid="user-section"]');
    await page.waitForSelector('[data-testid="prefs-section"]');
    const duration2 = Date.now() - start2;

    console.log(`Second load (header + prefs cached): ${duration2}ms`);
    expect(duration2).toBeGreaterThan(2000); // Session still takes 2s
    expect(duration2).toBeLessThan(5000); // But header + prefs cached

    // Get second load timestamps
    const header2Timestamp = await page.locator('[data-testid="header-timestamp"]').textContent();
    const user2Timestamp = await page.locator('[data-testid="user-timestamp"]').textContent();
    const prefs2Timestamp = await page.locator('[data-testid="prefs-timestamp"]').textContent();

    // Header should be SAME (cached static shell)
    expect(header2Timestamp).toBe(header1Timestamp);

    // User session should be DIFFERENT (always fresh, not cached)
    expect(user2Timestamp).not.toBe(user1Timestamp);

    // Preferences should be SAME (cached remote data)
    expect(prefs2Timestamp).toBe(prefs1Timestamp);

    await context.request.post("http://localhost:3000/api/test-clear");
  });

  test("revalidating static-header only affects header, not user session", async ({
    page,
    context,
  }) => {
    const sessionId = `session-${Date.now()}`;
    const prefsId = `prefs-${Date.now()}`;

    await Promise.all([
      context.request.post("http://localhost:3000/api/test-setup", {
        data: { testId: sessionId, scenario: "user-session" },
      }),
      context.request.post("http://localhost:3000/api/test-setup", {
        data: { testId: prefsId, scenario: "user-prefs" },
      }),
    ]);

    // First load
    await page.goto("http://localhost:3000/dynamic-suspense");
    await page.waitForSelector('[data-testid="prefs-section"]');

    // Second load - all cached except session
    const start2 = Date.now();
    await page.reload();
    await page.waitForSelector('[data-testid="prefs-section"]');
    const duration2 = Date.now() - start2;

    console.log(`With cached header + prefs: ${duration2}ms`);
    expect(duration2).toBeGreaterThan(2000); // Session
    expect(duration2).toBeLessThan(3000); // Header + prefs cached

    const header2Timestamp = await page.locator('[data-testid="header-timestamp"]').textContent();
    const prefs2Timestamp = await page.locator('[data-testid="prefs-timestamp"]').textContent();

    // Revalidate ONLY the static header
    await context.request.post("http://localhost:3000/api/revalidate-tag", {
      data: { tag: "static-header" },
    });

    // Third load: header refetches (3s), session always fresh (2s), prefs cached (<1s)
    const start3 = Date.now();
    await page.reload();
    await page.waitForSelector('[data-testid="prefs-section"]');
    const duration3 = Date.now() - start3;

    console.log(`After revalidating header: ${duration3}ms`);
    expect(duration3).toBeGreaterThan(3000); // Header refetching (3s minimum)
    expect(duration3).toBeLessThan(8000); // Prefs cached, but may be sequential

    const header3Timestamp = await page.locator('[data-testid="header-timestamp"]').textContent();
    const prefs3Timestamp = await page.locator('[data-testid="prefs-timestamp"]').textContent();

    // Header should be DIFFERENT (revalidated)
    expect(header3Timestamp).not.toBe(header2Timestamp);

    // Preferences should be SAME (not revalidated)
    expect(prefs3Timestamp).toBe(prefs2Timestamp);

    await context.request.post("http://localhost:3000/api/test-clear");
  });

  test("revalidating user-prefs only affects prefs, not header", async ({ page, context }) => {
    const sessionId = `session-${Date.now()}`;
    const prefsId = `prefs-${Date.now()}`;

    await Promise.all([
      context.request.post("http://localhost:3000/api/test-setup", {
        data: { testId: sessionId, scenario: "user-session" },
      }),
      context.request.post("http://localhost:3000/api/test-setup", {
        data: { testId: prefsId, scenario: "user-prefs" },
      }),
    ]);

    // First load
    await page.goto("http://localhost:3000/dynamic-suspense");
    await page.waitForSelector('[data-testid="prefs-section"]');

    // Second load - cached
    await page.reload();
    await page.waitForSelector('[data-testid="prefs-section"]');

    const header2Timestamp = await page.locator('[data-testid="header-timestamp"]').textContent();
    const prefs2Timestamp = await page.locator('[data-testid="prefs-timestamp"]').textContent();

    // Revalidate ONLY user preferences
    await context.request.post("http://localhost:3000/api/revalidate-tag", {
      data: { tag: "user-prefs" },
    });

    // Third load: header cached (<1s), session fresh (2s), prefs refetch (5s) = ~7s (sequential)
    const start3 = Date.now();
    await page.reload();
    await page.waitForSelector('[data-testid="prefs-section"]');
    const duration3 = Date.now() - start3;

    console.log(`After revalidating prefs: ${duration3}ms`);
    expect(duration3).toBeGreaterThan(2900); // Prefs refetching (allow small variance)
    expect(duration3).toBeLessThan(8000); // Header cached, session may or may not be concurrent

    const header3Timestamp = await page.locator('[data-testid="header-timestamp"]').textContent();
    const prefs3Timestamp = await page.locator('[data-testid="prefs-timestamp"]').textContent();

    // Header should be SAME (not revalidated)
    expect(header3Timestamp).toBe(header2Timestamp);

    // Preferences should be DIFFERENT (revalidated)
    expect(prefs3Timestamp).not.toBe(prefs2Timestamp);

    await context.request.post("http://localhost:3000/api/test-clear");
  });

  test("user session is NEVER cached, always streams fresh", async ({ page, context }) => {
    const sessionId = `session-${Date.now()}`;
    const prefsId = `prefs-${Date.now()}`;

    await Promise.all([
      context.request.post("http://localhost:3000/api/test-setup", {
        data: { testId: sessionId, scenario: "user-session" },
      }),
      context.request.post("http://localhost:3000/api/test-setup", {
        data: { testId: prefsId, scenario: "user-prefs" },
      }),
    ]);

    // Load page 3 times
    await page.goto("http://localhost:3000/dynamic-suspense");
    await page.waitForSelector('[data-testid="user-section"]');
    const user1Timestamp = await page.locator('[data-testid="user-timestamp"]').textContent();

    await page.reload();
    await page.waitForSelector('[data-testid="user-section"]');
    const user2Timestamp = await page.locator('[data-testid="user-timestamp"]').textContent();

    await page.reload();
    await page.waitForSelector('[data-testid="user-section"]');
    const user3Timestamp = await page.locator('[data-testid="user-timestamp"]').textContent();

    // All three should be DIFFERENT (never cached)
    expect(user1Timestamp).not.toBe(user2Timestamp);
    expect(user2Timestamp).not.toBe(user3Timestamp);
    expect(user1Timestamp).not.toBe(user3Timestamp);

    await context.request.post("http://localhost:3000/api/test-clear");
  });
});
