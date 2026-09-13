import { describe, expect, it } from "vitest";

// @ts-expect-error - build tooling, deliberately plain ESM rather than TypeScript
import { formatCommitLintSummary, lintPullRequestTitle } from "../scripts/commit-lint.mjs";

describe("lintPullRequestTitle", () => {
  it("accepts a bare type and subject", () => {
    expect(lintPullRequestTitle("feat: add guardian links")).toMatchObject({ valid: true });
  });

  it("accepts every type the convention allows", () => {
    for (const type of ["feat", "fix", "docs", "style", "refactor", "perf", "test", "chore", "ci"]) {
      expect(lintPullRequestTitle(`${type}: a subject`)).toMatchObject({ valid: true });
    }
  });

  it("accepts a scope and a breaking-change marker", () => {
    expect(lintPullRequestTitle("refactor(db)!: drop the legacy column")).toMatchObject({
      valid: true,
    });
  });

  it("accepts the titles Dependabot raises, so its pull requests are never flagged", () => {
    const titles = [
      "chore(deps): bump the npm-minor-and-patch group with 3 updates",
      "ci(deps): bump actions/checkout from 4.4.0 to 4.5.0",
      "chore(deps-dev): bump typescript from 5.7.3 to 5.8.0",
    ];

    for (const title of titles) {
      expect(lintPullRequestTitle(title)).toMatchObject({ valid: true });
    }
  });

  it("rejects a type outside the allowed set and names the allowed ones", () => {
    const result = lintPullRequestTitle("wip: still going");

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("wip");
    expect(result.reason).toContain("feat");
  });

  it("rejects a title with no type at all", () => {
    expect(lintPullRequestTitle("add guardian links")).toMatchObject({ valid: false });
  });

  it("rejects an uppercase type, because the convention is lowercase", () => {
    expect(lintPullRequestTitle("Feat: add guardian links")).toMatchObject({ valid: false });
  });

  it("rejects a missing space after the colon", () => {
    expect(lintPullRequestTitle("feat:add guardian links")).toMatchObject({ valid: false });
  });

  it("rejects an empty subject", () => {
    expect(lintPullRequestTitle("feat:   ")).toMatchObject({ valid: false });
  });

  it("rejects a missing title rather than throwing", () => {
    expect(lintPullRequestTitle(undefined)).toMatchObject({ valid: false });
  });
});

describe("formatCommitLintSummary", () => {
  it("reports a passing title", () => {
    const output = formatCommitLintSummary("feat: add guardian links");

    expect(output).toContain("feat: add guardian links");
    expect(output).toMatch(/follows Conventional Commits/i);
  });

  it("reports a failing title with the reason and an example to copy", () => {
    const output = formatCommitLintSummary("wip: still going");

    expect(output).toContain("wip");
    expect(output).toContain("feat(audit): record refused sign-ins");
  });

  it("says the check is advisory, so a reader knows the merge is not blocked", () => {
    expect(formatCommitLintSummary("wip: still going")).toMatch(/does not block/i);
  });
});
