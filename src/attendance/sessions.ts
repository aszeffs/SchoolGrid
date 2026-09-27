import { isInstructionalDay, schoolDatePlus, type SchoolDate } from "../calendar/index.ts";
import type { Queryable } from "../db/transaction.ts";

/**
 * Attendance sessions, their Roster snapshots, and the Attendance they record
 * (migrations/0022; CONTEXT.md: Attendance session, Roster snapshot,
 * Attendance), stored with their invariants held.
 *
 * Like the rest of this module, it decides nothing about who may act: whether
 * the actor may record is the Access module's, asked before any of this.
 */

/** Every status an Attendance record may hold, in the order a reader meets them. */
export const ATTENDANCE_STATUSES = [
  "present",
  "tardy",
  "excused_absence",
  "unexcused_absence",
  "absent_pending_review",
] as const;

export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export function isAttendanceStatus(value: unknown): value is AttendanceStatus {
  return ATTENDANCE_STATUSES.includes(value as AttendanceStatus);
}

/** One Student's status for one Class Offering on one School date, and who last recorded it when. */
export interface Attendance {
  id: string;
  schoolId: string;
  studentPersonId: string;
  classOfferingId: string;
  date: SchoolDate;
  status: AttendanceStatus;
  recordedByPersonId: string;
  recordedAt: Date;
}

/** The one session for a Class Offering on a School date. */
export interface AttendanceSession {
  id: string;
  schoolId: string;
  classOfferingId: string;
  date: SchoolDate;
  openedByPersonId: string;
  openedAt: Date;
}

/**
 * Why a captured Student cannot be marked on a session's date: the Roster
 * membership captured no longer covers it, or their Enrollment had ended by
 * then (CONTEXT.md: Roster snapshot).
 */
export type UnmarkableBecause = "not_rostered_on_date" | "enrollment_ended";

/** One Student a session's Roster snapshot captured, and why they cannot be marked on its date, if they cannot. */
export interface CapturedStudent {
  studentPersonId: string;
  unmarkableBecause: UnmarkableBecause | null;
}

/**
 * Why a School date's Attendance cannot be recorded, as far as the date alone
 * decides it: it is not an Instructional day in the Class Offering's Term, it
 * is after the School's today, or its Attendance window has closed.
 */
export type DateProblem = "not_instructional_day" | "after_today" | "attendance_window_closed";

/** Why a session is read-only for the actor, the date's own reasons first. */
export type ReadOnlyBecause = DateProblem | "not_teaching" | "not_taught_on_date";

/** Why one mark in a save was refused while the rest applied. */
export type MarkRefusal =
  /** The stored value is not the one the caller loaded: someone changed it since. */
  | "stale"
  /** An Absent-pending-review is resolved only through a Correction request. */
  | "absent_pending_review"
  /** The Student's Roster membership no longer covers the date, or their Enrollment had ended by then. */
  | "not_markable";

const SESSION_COLUMNS = `id, school_id AS "schoolId", class_offering_id AS "classOfferingId",
  to_char(date, 'YYYY-MM-DD') AS date, opened_by_person_id AS "openedByPersonId", opened_at AS "openedAt"`;

const ATTENDANCE_COLUMNS = `id, school_id AS "schoolId", student_person_id AS "studentPersonId",
  class_offering_id AS "classOfferingId", to_char(date, 'YYYY-MM-DD') AS date, status,
  recorded_by_person_id AS "recordedByPersonId", recorded_at AS "recordedAt"`;

/**
 * Why this School date's Attendance cannot be recorded, as far as the date
 * alone decides it, or null when it can. The window is open while the
 * School's today is no later than the date plus the window (CONTEXT.md:
 * Attendance window).
 */
export async function dateProblem(
  database: Queryable,
  {
    schoolId,
    term,
    date,
    today,
    attendanceWindow,
  }: {
    schoolId: string;
    term: { firstDate: SchoolDate; lastDate: SchoolDate };
    date: SchoolDate;
    today: SchoolDate;
    attendanceWindow: number;
  },
): Promise<DateProblem | null> {
  // `YYYY-MM-DD` sorts as the dates do.
  if (date < term.firstDate || date > term.lastDate || !(await isInstructionalDay(database, { schoolId, date }))) {
    return "not_instructional_day";
  }
  if (date > today) {
    return "after_today";
  }
  if (today > schoolDatePlus(date, attendanceWindow)) {
    return "attendance_window_closed";
  }
  return null;
}

/** The session for this Class Offering on this School date, or null when nobody has opened it. */
export async function findSession(
  database: Queryable,
  { schoolId, classOfferingId, date }: { schoolId: string; classOfferingId: string; date: SchoolDate },
): Promise<AttendanceSession | null> {
  const { rows } = await database.query<AttendanceSession>(
    `SELECT ${SESSION_COLUMNS} FROM app.attendance_session
     WHERE school_id = $1 AND class_offering_id = $2 AND date = $3`,
    [schoolId, classOfferingId, date],
  );
  return rows[0] ?? null;
}

/**
 * Opens the session for this Class Offering on this School date, or finds the
 * one already open, and holds it until the transaction ends, so saves to one
 * session take turns. One opened by two Faculty members at once is still one
 * session: the second waits for the first, and finds it. Says whether this
 * call opened it.
 *
 * Held by an advisory lock on the offering and date rather than by locking
 * the row, which would need an UPDATE grant on a table nothing updates.
 */
export async function openSession(
  transaction: Queryable,
  {
    schoolId,
    classOfferingId,
    date,
    openedByPersonId,
  }: { schoolId: string; classOfferingId: string; date: SchoolDate; openedByPersonId: string },
): Promise<{ session: AttendanceSession; opened: boolean }> {
  await transaction.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `attendance_session:${classOfferingId}:${date}`,
  ]);
  const { rowCount } = await transaction.query(
    `INSERT INTO app.attendance_session (school_id, class_offering_id, date, opened_by_person_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT ON CONSTRAINT attendance_session_one_per_date DO NOTHING`,
    [schoolId, classOfferingId, date, openedByPersonId],
  );
  const { rows } = await transaction.query<AttendanceSession>(
    `SELECT ${SESSION_COLUMNS} FROM app.attendance_session
     WHERE school_id = $1 AND class_offering_id = $2 AND date = $3`,
    [schoolId, classOfferingId, date],
  );
  return { session: rows[0]!, opened: (rowCount ?? 0) > 0 };
}

/**
 * Adds to a session's Roster snapshot every Roster membership of its Class
 * Offering covering its date that it has not captured yet. Nothing captured is
 * ever taken away (CONTEXT.md: Roster snapshot). Returns how many were added.
 */
export async function captureRoster(transaction: Queryable, session: AttendanceSession): Promise<number> {
  const { rowCount } = await transaction.query(
    `INSERT INTO app.roster_snapshot_member (school_id, attendance_session_id, roster_membership_id)
     SELECT m.school_id, $2, m.id
     FROM app.roster_membership m
     JOIN app.class_offering o ON o.school_id = m.school_id AND o.id = m.class_offering_id
     JOIN app.term t ON t.school_id = o.school_id AND t.id = o.term_id
     WHERE m.school_id = $1 AND m.class_offering_id = $3
       AND m.first_date <= $4 AND coalesce(m.last_date, t.last_date) >= $4
     ON CONFLICT DO NOTHING`,
    [session.schoolId, session.id, session.classOfferingId, session.date],
  );
  return rowCount ?? 0;
}

/**
 * The Students a session's Roster snapshot captured, each once, with why they
 * cannot be marked on its date, if they cannot. A membership moved since it was captured is
 * read as it stands now.
 */
export async function capturedStudents(database: Queryable, session: AttendanceSession): Promise<CapturedStudent[]> {
  const { rows } = await database.query<{ studentPersonId: string; rostered: boolean; enrolled: boolean }>(
    `SELECT m.student_person_id AS "studentPersonId",
       bool_or(m.first_date <= s.date AND coalesce(m.last_date, t.last_date) >= s.date) AS rostered,
       bool_or(
         EXISTS (
           SELECT 1 FROM app.enrollment e
           JOIN app.school school ON school.id = e.school_id
           WHERE e.school_id = m.school_id AND e.student_person_id = m.student_person_id
             AND (e.ended_at IS NULL OR (e.ended_at AT TIME ZONE school.timezone)::date >= s.date)
         )
       ) AS enrolled
     FROM app.roster_snapshot_member captured
     JOIN app.attendance_session s ON s.school_id = captured.school_id AND s.id = captured.attendance_session_id
     JOIN app.roster_membership m ON m.school_id = captured.school_id AND m.id = captured.roster_membership_id
     JOIN app.class_offering o ON o.school_id = m.school_id AND o.id = m.class_offering_id
     JOIN app.term t ON t.school_id = o.school_id AND t.id = o.term_id
     WHERE captured.school_id = $1 AND captured.attendance_session_id = $2
     GROUP BY m.student_person_id`,
    [session.schoolId, session.id],
  );
  return rows.map(({ studentPersonId, rostered, enrolled }) => ({
    studentPersonId,
    unmarkableBecause: !rostered ? "not_rostered_on_date" : !enrolled ? "enrollment_ended" : null,
  }));
}

/**
 * The Attendance recorded for a Class Offering on a School date, each
 * Student's at most once. `lock` holds each until the transaction ends.
 */
export async function attendanceOn(
  database: Queryable,
  { schoolId, classOfferingId, date }: { schoolId: string; classOfferingId: string; date: SchoolDate },
  { lock = false }: { lock?: boolean } = {},
): Promise<Attendance[]> {
  const { rows } = await database.query<Attendance>(
    `SELECT ${ATTENDANCE_COLUMNS} FROM app.attendance
     WHERE school_id = $1 AND class_offering_id = $2 AND date = $3
     ${lock ? "FOR UPDATE" : ""}`,
    [schoolId, classOfferingId, date],
  );
  return rows;
}

/** Every Attendance recorded for a Class Offering, on whichever School date, by date. */
export async function attendanceIn(
  database: Queryable,
  { schoolId, classOfferingId }: { schoolId: string; classOfferingId: string },
): Promise<Attendance[]> {
  const { rows } = await database.query<Attendance>(
    `SELECT ${ATTENDANCE_COLUMNS} FROM app.attendance
     WHERE school_id = $1 AND class_offering_id = $2
     ORDER BY date, id`,
    [schoolId, classOfferingId],
  );
  return rows;
}

/** Records a Student's first Attendance for a Class Offering on a School date. */
export async function recordAttendance(
  transaction: Queryable,
  attendance: Omit<Attendance, "id" | "recordedAt">,
): Promise<Attendance> {
  const { rows } = await transaction.query<Attendance>(
    `INSERT INTO app.attendance (school_id, student_person_id, class_offering_id, date, status, recorded_by_person_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${ATTENDANCE_COLUMNS}`,
    [
      attendance.schoolId,
      attendance.studentPersonId,
      attendance.classOfferingId,
      attendance.date,
      attendance.status,
      attendance.recordedByPersonId,
    ],
  );
  return rows[0]!;
}

/** Changes a locked Attendance record's status, naming who changed it, and now as when. */
export async function changeAttendance(
  transaction: Queryable,
  attendance: Attendance,
  { status, recordedByPersonId }: { status: AttendanceStatus; recordedByPersonId: string },
): Promise<Attendance> {
  const { rows } = await transaction.query<Attendance>(
    `UPDATE app.attendance SET status = $3, recorded_by_person_id = $4, recorded_at = now()
     WHERE school_id = $1 AND id = $2
     RETURNING ${ATTENDANCE_COLUMNS}`,
    [attendance.schoolId, attendance.id, status, recordedByPersonId],
  );
  return rows[0]!;
}
