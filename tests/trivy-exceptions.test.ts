import { describe, expect, it } from "vitest";

import {
  MAX_EXCEPTION_DAYS,
  checkTrivyExceptions,
  formatTrivyExceptionReport,
  // @ts-expect-error - build tooling, deliberately plain ESM rather than TypeScript
} from "../scripts/check-trivy-exceptions.mjs";

const TODAY = new Date("2026-09-12T00:00:00Z");

// A date `days` from TODAY, so the fixtures below say what they mean rather
// than carrying literals that quietly expire and turn this suite red.
function daysFromToday(days: number): string {
  const when = new Date(TODAY);
  when.setUTCDate(when.getUTCDate() + days);
  return when.toISOString().slice(0, 10);
}

function wellFormed(overrides: Record<string, string | null> = {}): string {
  const fields: Record<string, string | null> = {
    id: "CVE-2025-0001",
    statement: "No patched version exists in the distroless base; tracked upstream.",
    expired_at: daysFromToday(30),
    ...overrides,
  };

  const lines = Object.entries(fields)
    .filter(([, value]) => value !== null)
    .map(([key, value], index) => `${index === 0 ? "  - " : "    "}${key}: ${value}`);

  return ["vulnerabilities:", ...lines, ""].join("\n");
}

function check(text: string) {
  return checkTrivyExceptions(text, { today: TODAY });
}

describe("checkTrivyExceptions", () => {
  it("accepts a file recording no exceptions at all", () => {
    expect(check("# Nothing is excepted right now.\n")).toMatchObject({ ok: true });
  });

  it("accepts an exception carrying a justification and a future expiry", () => {
    expect(check(wellFormed())).toMatchObject({ ok: true, problems: [] });
  });

  it("checks every section Trivy honours, not just vulnerabilities", () => {
    for (const section of ["vulnerabilities", "misconfigurations", "secrets", "licenses"]) {
      const text = wellFormed({ expired_at: null }).replace("vulnerabilities:", `${section}:`);
      const result = check(text);

      expect(result.ok).toBe(false);
      expect(result.problems.join("\n")).toContain("CVE-2025-0001");
    }
  });

  // Trivy accepts an entry with neither field. Both omissions turn an
  // exception into a permanent, unexplained hole, which is the thing this
  // check exists to prevent.
  it("rejects an exception with no justification", () => {
    const result = check(wellFormed({ statement: null }));

    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/statement/);
  });

  it("rejects an exception with no expiry", () => {
    const result = check(wellFormed({ expired_at: null }));

    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/expired_at/);
  });

  it("rejects a justification too short to be one", () => {
    for (const statement of ['""', "TODO", "wontfix", '"   "']) {
      expect(check(wellFormed({ statement }))).toMatchObject({ ok: false });
    }
  });

  // Expiry is the whole point: an exception nobody revisits is a decision
  // taken once and inherited forever.
  it("rejects an exception that has already expired", () => {
    const result = check(wellFormed({ expired_at: daysFromToday(-1) }));

    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/expired/i);
  });

  it("rejects an expiry further out than the review horizon", () => {
    expect(check(wellFormed({ expired_at: daysFromToday(MAX_EXCEPTION_DAYS + 1) }))).toMatchObject({
      ok: false,
    });
    expect(check(wellFormed({ expired_at: daysFromToday(MAX_EXCEPTION_DAYS) }))).toMatchObject({
      ok: true,
    });
  });

  it("rejects a date that is not a date", () => {
    for (const expired_at of ["soon", "2026-13-40", "12/09/2026", "2026-09"]) {
      expect(check(wellFormed({ expired_at }))).toMatchObject({ ok: false });
    }
  });

  it("rejects an entry with no id, because a problem report needs to name one", () => {
    const result = check(
      [
        "vulnerabilities:",
        "  - statement: a reason long enough to count",
        `    expired_at: ${daysFromToday(30)}`,
        "",
      ].join("\n"),
    );

    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/id/);
  });

  // The silent failure this parser can have. Trivy's format is richer than
  // the subset understood here, so anything unrecognised has to be loud: a
  // section skipped quietly is an exception that passes this check while
  // Trivy honours it.
  it("rejects a top-level section it does not understand", () => {
    const result = check(["something_new:", "  - id: CVE-2025-0001", ""].join("\n"));

    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/something_new/);
  });

  // The mistake that actually happens: a plausible-looking key Trivy does not
  // read, leaving the exception unjustified while it looks justified.
  it("rejects a field inside an entry that it does not understand", () => {
    const result = check(wellFormed({ reason: "because it is unfixable" }));

    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/reason/);
  });

  it("rejects a line it cannot classify rather than skipping it", () => {
    const result = check(["vulnerabilities:", "  this is not a list entry", ""].join("\n"));

    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/line 2/);
  });

  it("rejects an entry sitting outside any section", () => {
    const result = check(["  - id: CVE-2025-0001", ""].join("\n"));

    expect(result.ok).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it("reports every problem, not only the first", () => {
    const text = [
      "vulnerabilities:",
      "  - id: CVE-2025-0001",
      "  - id: CVE-2025-0002",
      "",
    ].join("\n");

    expect(check(text).problems.length).toBeGreaterThanOrEqual(4);
  });

  // A justification long enough to be one does not fit on a line, so this is
  // the shape the file is actually written in. A parser that only read
  // single-line values would reject every real entry.
  it("reads a folded justification spanning several lines", () => {
    const text = [
      "vulnerabilities:",
      "  - id: CVE-2025-0001",
      "    statement: >-",
      "      No patched base image exists yet. Debian has published the fix;",
      "      the distroless rebuild carrying it has not shipped.",
      `    expired_at: ${daysFromToday(30)}`,
      "",
    ].join("\n");

    expect(check(text)).toMatchObject({ ok: true });
  });

  it("still rejects a folded justification too short to be one", () => {
    const text = [
      "vulnerabilities:",
      "  - id: CVE-2025-0001",
      "    statement: >-",
      "      wontfix",
      `    expired_at: ${daysFromToday(30)}`,
      "",
    ].join("\n");

    expect(check(text)).toMatchObject({ ok: false });
  });

  it("rejects a folded block that never says anything", () => {
    const text = [
      "vulnerabilities:",
      "  - id: CVE-2025-0001",
      "    statement: >-",
      `    expired_at: ${daysFromToday(30)}`,
      "",
    ].join("\n");

    expect(check(text)).toMatchObject({ ok: false });
  });

  it("ignores comments and blank lines wherever they appear", () => {
    const text = [
      "# a leading comment",
      "",
      "vulnerabilities:",
      "  # why this one is here",
      "  - id: CVE-2025-0001",
      "    statement: No patched version exists in the distroless base.",
      `    expired_at: ${daysFromToday(30)}`,
      "",
    ].join("\n");

    expect(check(text)).toMatchObject({ ok: true });
  });
});

describe("formatTrivyExceptionReport", () => {
  it("names the file and every problem when the check fails", () => {
    const result = check(wellFormed({ statement: null }));
    const report = formatTrivyExceptionReport(".trivyignore.yaml", result);

    expect(report).toContain(".trivyignore.yaml");
    expect(report).toContain("CVE-2025-0001");
  });

  it("says so plainly when the check passes", () => {
    const report = formatTrivyExceptionReport(".trivyignore.yaml", check(wellFormed()));

    expect(report).toMatch(/ok|pass/i);
  });
});
