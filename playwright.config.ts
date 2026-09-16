import { defineConfig, devices } from "@playwright/test";

/**
 * The browser suite. It drives a running SchoolGrid, never a development server:
 * in CI that is the image built for the pull request, once scripts/smoke-test.sh
 * has passed it, so what passes here is what ships.
 *
 * It covers only what a browser alone can show. Domain behaviour is asserted at
 * the HTTP seam, and is not tested again through the page.
 */
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  // One server and one database behind every test, so tests run one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: process.env["CI"] !== undefined,
  // A retry would turn a flaky guarantee into a green build.
  retries: 0,
  reporter: process.env["CI"] === undefined ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env["SCHOOLGRID_ORIGIN"] ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
