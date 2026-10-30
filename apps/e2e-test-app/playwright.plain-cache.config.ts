import { defineConfig } from "@playwright/test";

// Focused local run; CI also discovers this spec through the regular Redis lanes.
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "plain-cache-redis.spec.ts",
  workers: 1,
});
