import { expect, it } from "vitest";

// Temporary. Proves the CI gate goes red on a failing test. Reverted in the
// next commit.
it("deliberately fails", () => {
  expect(1).toBe(2);
});
