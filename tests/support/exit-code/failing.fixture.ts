import { expect, it } from "vitest";

// Deliberately red. This fixture exists to be run as a child process by
// tests/exit-code.test.ts, which asserts that a failing run exits non-zero.
it("fails on purpose", () => {
  expect(1).toBe(2);
});
