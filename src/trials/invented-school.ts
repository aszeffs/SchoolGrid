import type { Role } from "../access/roles.ts";
import type { AttendanceStatus } from "../attendance/sessions.ts";
import type { SchoolDate } from "../calendar/index.ts";

/**
 * What a Trial School holds when it starts: invented Persons, and an Academic
 * Year of Terms, holidays, Courses and Class Offerings around the School's own
 * today, taught by the Faculty member and attended by the Student among
 * invented classmates. Every name here is made up.
 *
 * A description and nothing more, the same for any two trials started on the
 * same School date. Building it is the Trials module's, through the same
 * domain operations the app uses, so it cannot drift from their rules.
 */
export interface InventedSchool {
  /** The Person each School role's account resolves to, by role. */
  rolePersons: Readonly<Record<Role, string>>;
  /** Persons no one acts as, so that a Class Offering has a roster and the Student has classmates. */
  otherFaculty: readonly string[];
  otherStudents: readonly string[];
  academicYear: { name: string; firstDate: SchoolDate; lastDate: SchoolDate };
  terms: readonly { name: string; firstDate: SchoolDate; lastDate: SchoolDate }[];
  holidays: readonly SchoolDate[];
  courses: readonly InventedCourse[];
}

export interface InventedCourse {
  name: string;
  code: string;
  /** One Class Offering per label in every Term; a single null is one with no label. */
  labels: readonly (string | null)[];
  /** Whether the Faculty role's Person teaches it; the other Faculty member teaches the rest. */
  taughtByRole: boolean;
  /** The Students rostered in each of its offerings, by label, named as above. */
  rosters: Readonly<Record<string, readonly string[]>>;
}

/** Every Trial School's name. */
export const INVENTED_SCHOOL_NAME = "Riverbend School";

/** The label key for an offering that has none. */
export const NO_LABEL = "";

const STUDENT = "Jamie Lindqvist";
const CLASSMATES = ["Avery Castellano", "Casey Moreau", "Jordan Okafor", "Quinn Adebayo", "Riley Fernsby", "Taylor Nakamura"];
const EVERY_STUDENT = [STUDENT, ...CLASSMATES];

/**
 * The invented School around this School date.
 *
 * Its Academic Year runs from the 1st of August to the 31st of July, the whole
 * of it, so today always falls in it and a Term is always running. Three Terms
 * cover it with no gap, and a few holidays each fall on a day the Monday to
 * Friday pattern would otherwise have taught.
 */
export function inventedSchool(today: SchoolDate): InventedSchool {
  const [year, month] = today.split("-").map(Number) as [number, number];
  const startYear = month < 8 ? year - 1 : year;
  const start = Date.UTC(startYear, 7, 1);
  const monthsIn = (months: number) => Date.UTC(startYear, 7 + months, 1);

  return {
    rolePersons: {
      school_administrator: "Morgan Reyes",
      faculty: "Sam Achterberg",
      student: STUDENT,
      guardian: "Alex Lindqvist",
    },
    otherFaculty: ["Priya Okonkwo"],
    otherStudents: CLASSMATES,
    academicYear: {
      // "2026–27" names the year beginning in August 2026.
      name: `${startYear}–${String((startYear + 1) % 100).padStart(2, "0")}`,
      firstDate: dateOf(start),
      lastDate: dateOf(dayBefore(monthsIn(12))),
    },
    terms: [
      { name: "Autumn Term", from: 0, to: 5 },
      { name: "Spring Term", from: 5, to: 9 },
      { name: "Summer Term", from: 9, to: 12 },
    ].map(({ name, from, to }) => ({ name, firstDate: dateOf(monthsIn(from)), lastDate: dateOf(dayBefore(monthsIn(to))) })),
    holidays: [
      { months: 1, days: 0, weekday: MONDAY },
      { months: 2, days: 12, weekday: MONDAY },
      { months: 6, days: 14, weekday: MONDAY },
      { months: 8, days: 10, weekday: FRIDAY },
    ].map(({ months, days, weekday }) => dateOf(onOrAfter(monthsIn(months) + days * DAY, weekday))),
    courses: [
      {
        name: "Mathematics",
        code: "MATH",
        labels: ["Section A", "Section B"],
        taughtByRole: true,
        rosters: { "Section A": EVERY_STUDENT.slice(0, 4), "Section B": EVERY_STUDENT.slice(4) },
      },
      single("English Literature", "ENG", false, EVERY_STUDENT),
      single("Biology", "BIO", true, EVERY_STUDENT),
      single("World History", "HIST", false, EVERY_STUDENT),
      single("Art", "ART", false, EVERY_STUDENT.slice(4)),
    ],
  };
}

/** One invented Student's Attendance in one invented Class Offering, named as the invented School names them. */
export interface InventedMark {
  /** The Course's code, and the offering's label, NO_LABEL for none. */
  course: string;
  label: string;
  student: string;
  date: SchoolDate;
  status: AttendanceStatus;
}

/** The Attendance a Trial School starts with, and the Correction request its Faculty role has raised. */
export interface InventedAttendance {
  /** Every session is taken on each day given; a rostered Student with no mark on one is a deliberate gap. */
  marks: InventedMark[];
  /** Pending, raised by the Faculty role; null with no day behind the School to raise it for. */
  correctionRequest:
    | (Omit<InventedMark, "status"> & { before: AttendanceStatus | null; after: AttendanceStatus; reason: string })
    | null;
}

/** Where the Faculty role's Attendance is most worth showing: the Student role's class that they teach. */
const SHOWN_COURSE = "MATH";
const SHOWN_LABEL = "Section A";
/** The classmates the shown class leaves unmarked, and asks to have excused. */
const UNMARKED = "Jordan Okafor";
const EXCUSED = "Avery Castellano";

/**
 * The Attendance every invented Class Offering was taken with on `pastDays`,
 * the current Term's Instructional days before today, in order: mostly
 * Present, with some tardiness and absences, and a few Students left
 * unmarked, the same for any two trials given the same days.
 *
 * On the last of them, the Student role is Absent-pending-review in the class
 * the Faculty role teaches them, and a classmate there is left unmarked, which
 * the Faculty role may still fill in. The Faculty role has asked for another
 * classmate's unexcused absence there to be excused, on the last day the
 * Attendance window has closed on, or the first day when it has closed on
 * none, so the School Administrator has a request waiting.
 */
export function inventedAttendance(
  school: InventedSchool,
  { pastDays, today, attendanceWindow }: { pastDays: readonly SchoolDate[]; today: SchoolDate; attendanceWindow: number },
): InventedAttendance {
  const lastDay = pastDays.at(-1);
  if (lastDay === undefined) {
    return { marks: [], correctionRequest: null };
  }
  const closedOn = (date: SchoolDate) => Date.parse(today) - Date.parse(date) > attendanceWindow * DAY;
  const excusedOn = pastDays.findLast(closedOn) ?? pastDays[0]!;

  /** What the shown class holds on a day by design: a status, null for a gap, or undefined where it is as any other. */
  const arranged = (student: string, date: SchoolDate): AttendanceStatus | null | undefined => {
    if (date === lastDay && student === school.rolePersons.student) {
      return "absent_pending_review";
    }
    if (date === lastDay && student === UNMARKED) {
      return null;
    }
    return date === excusedOn && student === EXCUSED ? "unexcused_absence" : undefined;
  };

  const marks: InventedMark[] = [];
  for (const { code, labels, rosters } of school.courses) {
    for (const label of labels.map((label) => label ?? NO_LABEL)) {
      const shown = code === SHOWN_COURSE && label === SHOWN_LABEL;
      for (const student of rosters[label] ?? []) {
        for (const date of pastDays) {
          const set = shown ? arranged(student, date) : undefined;
          // The last day's sessions were taken whole, but for the gap arranged.
          const status = set !== undefined ? set : usualStatus(`${code}|${label}|${student}|${date}`, date !== lastDay);
          if (status !== null) {
            marks.push({ course: code, label, student, date, status });
          }
        }
      }
    }
  }
  return {
    marks,
    correctionRequest: {
      course: SHOWN_COURSE,
      label: SHOWN_LABEL,
      student: EXCUSED,
      date: excusedOn,
      before: "unexcused_absence",
      after: "excused_absence",
      reason: "A note from home says it was a medical appointment.",
    },
  };
}

/**
 * A Student's status on an ordinary day, drawn from the day and class alone,
 * or null for a mark missed, when `mayMiss`.
 */
function usualStatus(key: string, mayMiss: boolean): AttendanceStatus | null {
  const roll = fnv1a(key) % 100;
  if (roll < 4) {
    return "tardy";
  }
  if (roll < 7) {
    return "excused_absence";
  }
  if (roll < 9) {
    return "unexcused_absence";
  }
  if (roll < 10 && mayMiss) {
    return null;
  }
  return "present";
}

/** A 32-bit FNV-1a hash: a stable, even spread, where no randomness is wanted. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
}

function single(name: string, code: string, taughtByRole: boolean, roster: readonly string[]): InventedCourse {
  return { name, code, labels: [null], taughtByRole, rosters: { [NO_LABEL]: roster } };
}

const DAY = 24 * 60 * 60 * 1000;
const MONDAY = 1;
const FRIDAY = 5;

function dayBefore(instant: number): number {
  return instant - DAY;
}

/** The first day on or after this one falling on the ISO weekday given, 1 being Monday. */
function onOrAfter(instant: number, weekday: number): number {
  const isoWeekday = new Date(instant).getUTCDay() || 7;
  return instant + ((weekday - isoWeekday + 7) % 7) * DAY;
}

/** Midnight UTC stands for the calendar date alone: no timezone is involved in counting days. */
function dateOf(instant: number): SchoolDate {
  return new Date(instant).toISOString().slice(0, 10);
}
