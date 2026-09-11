import { describe, expect, it } from "vitest";

// Deliberately failing, to prove a red required check blocks the merge.
// Removed with its branch once the evidence is recorded on issue #22.
describe("branch protection probe", () => {
  it("fails on purpose", () => {
    expect(1).toBe(2);
  });
});
