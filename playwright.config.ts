import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3200);

/**
 * E2E runs against a production build (`npm run build` first) on a real Postgres.
 * Set E2E_BASE_URL to run the same suite against a deployed URL instead.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`,
    ...devices["Pixel 7"], // mobile-first: test the layout people actually use
    trace: "retain-on-failure",
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npx next start -p ${PORT}`,
        url: `http://localhost:${PORT}/api/health`,
        reuseExistingServer: false,
        timeout: 60_000,
        env: { SPLIT_PERCENT_B: "50", PARTNER_WEBHOOK_URL: "" },
      },
});
