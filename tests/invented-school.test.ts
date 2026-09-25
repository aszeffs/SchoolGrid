import { describe, expect, it } from "vitest";
import { inventedSchool } from "../src/trials/invented-school.ts";

/** The ISO weekday of a date, 1 being Monday. */
function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
}

describe("the invented School a trial starts with", () => {
  // The days a calendar is most likely to get wrong: either end of the year,
  // either side of the turn of the calendar year, and a leap day.
  it.each(["2026-08-01", "2027-07-31", "2026-12-31", "2027-01-01", "2028-02-29"])(
    "on %s, holds a year and exactly one running Term around today, with no gap between Terms",
    (today) => {
      const { academicYear, terms, holidays } = inventedSchool(today);

      expect(academicYear.firstDate <= today && today <= academicYear.lastDate).toBe(true);
      expect(academicYear.firstDate.slice(5)).toBe("08-01");
      expect(academicYear.lastDate.slice(5)).toBe("07-31");
      expect(terms.filter((term) => term.firstDate <= today && today <= term.lastDate)).toHaveLength(1);
      expect(terms[0]!.firstDate).toBe(academicYear.firstDate);
      expect(terms.at(-1)!.lastDate).toBe(academicYear.lastDate);
      for (const [earlier, later] of terms.slice(0, -1).map((term, index) => [term, terms[index + 1]!] as const)) {
        const dayAfter = new Date(Date.parse(`${earlier.lastDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
        expect(later.firstDate).toBe(dayAfter);
      }
      for (const holiday of holidays) {
        expect(academicYear.firstDate <= holiday && holiday <= academicYear.lastDate).toBe(true);
        expect(weekdayOf(holiday)).toBeLessThanOrEqual(5);
      }
    },
  );

  it("names the year by the calendar years it spans", () => {
    expect(inventedSchool("2026-09-25").academicYear.name).toBe("2026–27");
    expect(inventedSchool("2100-03-01").academicYear.name).toBe("2099–00");
  });
});
