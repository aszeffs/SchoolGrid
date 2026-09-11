import { describe, expect, it } from "vitest";

// Deliberate type error, to prove a red required check blocks the merge.
// Removed with its branch once the evidence is recorded on issue #22.
const branches: number = "main";

describe("branch protection probe", () => {
  it("fails to typecheck on purpose", () => {
    expect(branches).toBe("main");
  });
});
