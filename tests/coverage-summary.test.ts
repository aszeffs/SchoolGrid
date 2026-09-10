import { describe, expect, it } from "vitest";

// @ts-expect-error - build tooling, deliberately plain ESM rather than TypeScript
import { formatCoverageSummary } from "../scripts/coverage-summary.mjs";

const metric = (pct: number, covered: number, total: number) => ({
  pct,
  covered,
  total,
  skipped: 0,
});

describe("formatCoverageSummary", () => {
  it("renders each metric as a percentage with its covered-over-total counts", () => {
    const output = formatCoverageSummary({
      total: {
        statements: metric(87.5, 70, 80),
        branches: metric(60, 6, 10),
        functions: metric(100, 12, 12),
        lines: metric(87.5, 70, 80),
      },
    });

    expect(output).toContain("| Statements | Branches | Functions | Lines |");
    expect(output).toContain("| 87.5% (70/80) | 60% (6/10) | 100% (12/12) | 87.5% (70/80) |");
  });

  it("reports a missing report rather than throwing, so a failed test run still summarises", () => {
    expect(formatCoverageSummary(null)).toContain("No coverage report was produced.");
  });
});
