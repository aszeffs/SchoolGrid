import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const vitestCli = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const fixtureConfig = "tests/support/exit-code/vitest.config.ts";

async function runFixture(): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [vitestCli, "run", "--config", fixtureConfig], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("close", resolve);
  });
}

// The guarantee here is the one the whole pipeline rests on: a red test must
// make the command red. It was not true once. embedded-postgres registers an
// exit hook that force-exits the process with a hardcoded 0, and the suite's
// global setup has to strip it. This runs the real global setup against a
// deliberately failing test, in a child process, and checks the exit code.
it(
  "exits non-zero when a test fails",
  async () => {
    expect(await runFixture()).toBe(1);
  },
  120_000,
);
