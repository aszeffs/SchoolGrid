import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["./tests/support/global-setup.ts"],
    // Starting a real Postgres and creating a database per test costs more
    // than a fake would. That cost is the point: the guarantees under test
    // are database guarantees.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // No threshold. A percentage measured against a walking skeleton says
      // nothing useful, and a floor set this early only teaches you to game
      // it. Make the number visible now; set the floor against real code.
      reporter: ["text", "text-summary", "html", "json-summary"],
      reportsDirectory: "coverage",
    },
  },
});
