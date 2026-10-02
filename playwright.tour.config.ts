import { defineConfig, devices } from "@playwright/test";

/**
 * The landing page tour's screenshots, made from the real app by
 * `npm run screenshots` and committed under web/public/tour/. Not a test
 * suite, and never run by CI: the owner runs it when a toured page changes,
 * and reviews the new images in the pull request.
 *
 * It boots its own showcase (e2e/tour/stack.ts), so it needs `npm run build`
 * first and nothing else.
 */
const PORT = Number(process.env["TOUR_PORT"] ?? 3100);

export default defineConfig({
  testDir: "e2e/tour",
  testMatch: "*.tour.ts",
  globalSetup: "./e2e/tour/global-setup.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    },
  ],
});
