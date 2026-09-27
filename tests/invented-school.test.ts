import { describe, expect, it } from "vitest";
import { inventedAttendance, inventedSchool, NO_LABEL } from "../src/trials/invented-school.ts";

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

describe("the Attendance a trial starts with", () => {
  const TODAY = "2026-10-21";
  const WINDOW = 7;
  const school = inventedSchool(TODAY);
  /** The current Term's Instructional days before today: every weekday since it began, as a holiday-free stretch. */
  const PAST_DAYS = weekdaysBetween("2026-08-03", "2026-10-20");

  /** Every Student each invented Class Offering is taken for, by course code and label. */
  const rosters = school.courses.flatMap((course) =>
    course.labels.map((label) => ({ course: course.code, label: label ?? NO_LABEL, roster: course.rosters[label ?? NO_LABEL]! })),
  );

  it("marks the rostered Students of every offering on past days alone, mostly Present, with some absences and a few gaps", () => {
    const { marks } = inventedAttendance(school, { pastDays: PAST_DAYS, today: TODAY, attendanceWindow: WINDOW });

    const expected = rosters.reduce((sum, { roster }) => sum + roster.length, 0) * PAST_DAYS.length;
    const gaps = expected - marks.length;
    for (const mark of marks) {
      expect(PAST_DAYS).toContain(mark.date);
      expect(rosters.find((offering) => offering.course === mark.course && offering.label === mark.label)?.roster).toContain(
        mark.student,
      );
    }
    expect(new Set(marks.map((mark) => `${mark.course}|${mark.label}|${mark.student}|${mark.date}`)).size).toBe(marks.length);
    expect(gaps).toBeGreaterThan(0);
    expect(gaps / expected).toBeLessThan(0.03);
    const count = (status: string) => marks.filter((mark) => mark.status === status).length;
    expect(count("present") / marks.length).toBeGreaterThan(0.8);
    for (const status of ["tardy", "excused_absence", "unexcused_absence"]) {
      expect(count(status)).toBeGreaterThan(0);
    }
    expect(count("absent_pending_review")).toBe(1);
  });

  it("leaves the Absent-pending-review, and a gap, on the last day in the Class Offering the Faculty role teaches the Student role in", () => {
    const { marks } = inventedAttendance(school, { pastDays: PAST_DAYS, today: TODAY, attendanceWindow: WINDOW });
    const lastDay = PAST_DAYS.at(-1)!;
    const taught = new Set(school.courses.filter((course) => course.taughtByRole).map((course) => course.code));

    const pending = marks.find((mark) => mark.status === "absent_pending_review")!;
    expect(pending).toEqual(expect.objectContaining({ student: school.rolePersons.student, date: lastDay }));
    expect(taught.has(pending.course)).toBe(true);
    const onLastDay = rosters.find((offering) => offering.course === pending.course && offering.label === pending.label)!;
    const marked = marks.filter((mark) => mark.course === pending.course && mark.label === pending.label && mark.date === lastDay);
    expect(marked.length).toBe(onLastDay.roster.length - 1);
  });

  it("has the Faculty role request a closed absence be excused, in a Class Offering they teach", () => {
    const { marks, correctionRequest } = inventedAttendance(school, { pastDays: PAST_DAYS, today: TODAY, attendanceWindow: WINDOW });

    const request = correctionRequest!;
    const target = marks.find(
      (mark) =>
        mark.course === request.course && mark.label === request.label && mark.student === request.student && mark.date === request.date,
    );
    expect(target?.status).toBe("unexcused_absence");
    expect(request.before).toBe(target?.status);
    expect(request.after).toBe("excused_absence");
    expect(request.reason.length).toBeGreaterThan(0);
    // Outside the Attendance window, so only a Correction request could change it.
    expect(Date.parse(TODAY) - Date.parse(request.date)).toBeGreaterThan(WINDOW * 86_400_000);
    expect(school.courses.find((course) => course.code === request.course)?.taughtByRole).toBe(true);
  });

  it("still raises its request on a day inside the window when no closed day has passed", () => {
    const pastDays = ["2026-10-19", "2026-10-20"];

    const { marks, correctionRequest } = inventedAttendance(school, { pastDays, today: TODAY, attendanceWindow: WINDOW });

    expect(pastDays).toContain(correctionRequest!.date);
    expect(marks.filter((mark) => mark.status === "absent_pending_review")).toHaveLength(1);
  });

  it("is nothing on a Term's first day, with no day before it to have taken", () => {
    expect(inventedAttendance(school, { pastDays: [], today: TODAY, attendanceWindow: WINDOW })).toEqual({
      marks: [],
      correctionRequest: null,
    });
  });

  it("is the same for two trials started on the same day", () => {
    const options = { pastDays: PAST_DAYS, today: TODAY, attendanceWindow: WINDOW };
    expect(inventedAttendance(inventedSchool(TODAY), options)).toEqual(inventedAttendance(inventedSchool(TODAY), options));
  });
});

/** Every Monday to Friday from `first` to `last`, both included. */
function weekdaysBetween(first: string, last: string): string[] {
  const days: string[] = [];
  for (let at = Date.parse(`${first}T00:00:00Z`); at <= Date.parse(`${last}T00:00:00Z`); at += 86_400_000) {
    const date = new Date(at).toISOString().slice(0, 10);
    if (weekdayOf(date) <= 5) {
      days.push(date);
    }
  }
  return days;
}
