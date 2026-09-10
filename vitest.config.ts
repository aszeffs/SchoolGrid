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
  },
});
