import { instructionalDaysBetween, type SchoolDate } from "../calendar/index.ts";
import type { Queryable } from "../db/transaction.ts";
import { ATTENDANCE_STATUSES, attendanceIn, type Attendance, type AttendanceStatus } from "./sessions.ts";

/**
 * A Class Offering's Attendance as a whole, and each Student's Attendance
 * totals in it (CONTEXT.md: Attendance totals), computed on read, never
 * stored: a changed Instructional day pattern shows at once.
 *
 * Like the rest of this module, it decides nothing about who may read it.
 */

/** What Attendance totals count: each status, and the Instructional days with no mark. */
export type Tally = AttendanceStatus | "not_recorded";

export type AttendanceTotals = Record<Tally, number>;

/** One Roster membership's bounds. Null while it is open: it runs to the end of its Term. */
export interface RosteredBounds {
  firstDate: SchoolDate;
  lastDate: SchoolDate | null;
}

/** One School date the offering's Attendance is shown on, and whether it counts. */
export interface AttendanceDate {
  date: SchoolDate;
  /** False for a date that holds Attendance but is no longer an Instructional day, which is not counted. */
  instructional: boolean;
}

/** One Student's part in a Class Offering's Attendance. */
export interface StudentAttendance {
  studentPersonId: string;
  rosterMemberships: RosteredBounds[];
  attendance: Attendance[];
  totals: AttendanceTotals;
}

/**
 * A Class Offering's Attendance up to the School's today: the dates it is
 * shown on, which are its Term's Instructional days so far and any other date
 * that holds a mark; and each Student ever rostered in it, or marked in it,
 * with their marks and totals. Given `studentPersonId`, that Student alone.
 */
export async function classOfferingAttendance(
  database: Queryable,
  {
    offering,
    today,
    studentPersonId = null,
  }: {
    offering: { id: string; schoolId: string; term: { firstDate: SchoolDate; lastDate: SchoolDate } };
    today: SchoolDate;
    studentPersonId?: string | null;
  },
): Promise<{ dates: AttendanceDate[]; students: StudentAttendance[] }> {
  const { schoolId, term } = offering;
  // `YYYY-MM-DD` sorts as the dates do. Before the Term begins, the range is empty.
  const instructionalDays = await instructionalDaysBetween(database, {
    schoolId,
    from: term.firstDate,
    to: [today, term.lastDate].sort()[0]!,
  });
  const marks = await attendanceIn(database, { schoolId, classOfferingId: offering.id, studentPersonId });
  const { rows: memberships } = await database.query<RosteredBounds & { studentPersonId: string }>(
    `SELECT student_person_id AS "studentPersonId", to_char(first_date, 'YYYY-MM-DD') AS "firstDate",
       to_char(last_date, 'YYYY-MM-DD') AS "lastDate"
     FROM app.roster_membership
     WHERE school_id = $1 AND class_offering_id = $2 AND ($3::uuid IS NULL OR student_person_id = $3)
     ORDER BY first_date, id`,
    [schoolId, offering.id, studentPersonId],
  );

  const instructional = new Set(instructionalDays);
  const students = new Map<string, Omit<StudentAttendance, "totals">>();
  const studentOf = (studentPersonId: string) => {
    const held = students.get(studentPersonId) ?? { studentPersonId, rosterMemberships: [], attendance: [] };
    students.set(studentPersonId, held);
    return held;
  };
  for (const { studentPersonId, firstDate, lastDate } of memberships) {
    studentOf(studentPersonId).rosterMemberships.push({ firstDate, lastDate });
  }
  for (const mark of marks) {
    studentOf(mark.studentPersonId).attendance.push(mark);
  }
  const dates = [...new Set([...instructionalDays, ...marks.map((mark) => mark.date)])]
    .sort()
    .map((date) => ({ date, instructional: instructional.has(date) }));
  return {
    dates,
    students: [...students.values()].map((student) => ({
      ...student,
      totals: totalsOf(student, instructionalDays, instructional, term.lastDate),
    })),
  };
}

/** One Student's part in one Class Offering, each mark saying whether it counts toward the totals. */
export interface OwnAttendance<O> {
  offering: O;
  rosterMemberships: RosteredBounds[];
  attendance: { date: SchoolDate; status: AttendanceStatus; counted: boolean }[];
  totals: AttendanceTotals;
}

/**
 * One Student's Attendance and totals up to the School's today in each of
 * these Class Offerings they were ever rostered in or marked in, the latest
 * Term first and each Term's offerings in the order given. `offerings` are
 * the School's, listed in Term order.
 */
export async function studentAttendance<
  O extends { id: string; schoolId: string; term: { id: string; firstDate: SchoolDate; lastDate: SchoolDate } },
>(
  database: Queryable,
  {
    schoolId,
    studentPersonId,
    offerings,
    today,
  }: { schoolId: string; studentPersonId: string; offerings: readonly O[]; today: SchoolDate },
): Promise<OwnAttendance<O>[]> {
  const { rows } = await database.query<{ classOfferingId: string }>(
    `SELECT class_offering_id AS "classOfferingId" FROM app.roster_membership
     WHERE school_id = $1 AND student_person_id = $2
     UNION
     SELECT class_offering_id FROM app.attendance
     WHERE school_id = $1 AND student_person_id = $2`,
    [schoolId, studentPersonId],
  );
  const attended = new Set(rows.map((row) => row.classOfferingId));
  const held = offerings.filter((offering) => attended.has(offering.id));
  const terms = [...new Set(held.map((offering) => offering.term.id))].reverse();
  // Stable, so each Term keeps its offerings in the order given.
  held.sort((a, b) => terms.indexOf(a.term.id) - terms.indexOf(b.term.id));
  const own: OwnAttendance<O>[] = [];
  for (const offering of held) {
    const { dates, students } = await classOfferingAttendance(database, { offering, today, studentPersonId });
    const counted = new Set(dates.filter((date) => date.instructional).map((date) => date.date));
    // Rostered or marked in it, so they are among its Students.
    const { rosterMemberships, attendance, totals } = students[0]!;
    own.push({
      offering,
      rosterMemberships,
      attendance: attendance.map(({ date, status }) => ({ date, status, counted: counted.has(date) })),
      totals,
    });
  }
  return own;
}

/**
 * One Student's Attendance totals: each status over Instructional days, and
 * Not recorded, the Instructional days so far inside one of their Roster
 * memberships that have no mark. A mark on a date that is no longer an
 * Instructional day is not counted.
 */
function totalsOf(
  { rosterMemberships, attendance }: Omit<StudentAttendance, "studentPersonId" | "totals">,
  instructionalDays: SchoolDate[],
  instructional: ReadonlySet<SchoolDate>,
  termLastDate: SchoolDate,
): AttendanceTotals {
  const totals = Object.fromEntries([...ATTENDANCE_STATUSES, "not_recorded"].map((tally) => [tally, 0])) as AttendanceTotals;
  const marked = new Set(attendance.map((mark) => mark.date));
  for (const { date, status } of attendance) {
    if (instructional.has(date)) {
      totals[status] += 1;
    }
  }
  const rostered = (date: SchoolDate) =>
    rosterMemberships.some(({ firstDate, lastDate }) => firstDate <= date && date <= (lastDate ?? termLastDate));
  totals.not_recorded = instructionalDays.filter((date) => !marked.has(date) && rostered(date)).length;
  return totals;
}
