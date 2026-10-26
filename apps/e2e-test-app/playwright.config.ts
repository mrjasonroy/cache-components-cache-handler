import { defineConfig, devices } from "@playwright/test";

// Redis lanes (E2E_REDIS_CONTAINER set) also start a second `next start` on 3001 against the
// same Redis, for the cross-instance specs. The outage spec stops Redis, so it only runs when
// E2E_OUTAGE=1, in its own CI step after the main suite.
const redisLane = Boolean(process.env.E2E_REDIS_CONTAINER);
const outageRun = process.env.E2E_OUTAGE === "1";
// E2E_CONFIG=16.4.2: the app is wired the 16.4.2 way (next.config.mjs). Its "use cache" data
// stack keeps 16.4.2's key layout and has no flushCache, so the specs that assert withCache's
// layout or call flushCache do not apply.
const config16_4_2 = process.env.E2E_CONFIG === "16.4.2";

const server = (port: number) => ({
  // IMPORTANT: Must use production build for cache testing
  // "use cache" and cache components don't persist in dev mode
  // Build is done separately in CI, this just starts the server
  command: `npm run start -- -p ${port}`,
  url: `http://localhost:${port}`,
  reuseExistingServer: !process.env.CI,
  timeout: 120 * 1000,
  stdout: "pipe" as const,
  stderr: "pipe" as const,
});

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60 * 1000, // 60 seconds per test (accommodate 3s delays + overhead)
  grep: outageRun ? /@outage/ : undefined,
  grepInvert: outageRun ? undefined : /@outage/,
  testIgnore: config16_4_2 ? ["**/data-handlers.spec.ts", "**/flush.spec.ts"] : undefined,
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: redisLane ? [server(3000), server(3001)] : [server(3000)],
});
