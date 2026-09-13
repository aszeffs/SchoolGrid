import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// A miniature copy of the root config: the same global setup, a single
// deliberately failing test, and a file suffix the root config's include glob
// does not match, so this fixture only ever runs when it is asked for.
export default defineConfig({
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["*.fixture.ts"],
    globalSetup: ["../global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
