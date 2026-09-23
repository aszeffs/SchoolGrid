import type { Queryable } from "../db/transaction.ts";
import type { Person } from "../identity/index.ts";

/**
 * Enrollments as stored. Each is one Student's participation in the School,
 * open from when it was recorded until it ended; a Student who leaves and
 * returns holds one row per stay. Rows are never deleted, and whose they are
 * and when they began never change (migrations/0007).
 *
 * Nothing here decides whether anyone may see or change an Enrollment: that is
 * the decision in ./index.ts, made before any of this is reached.
 */
export interface Enrollment {
  id: string;
  schoolId: string;
  studentPersonId: string;
  startedAt: Date;
  /** Null while the Enrollment is open. */
  endedAt: Date | null;
  /** Null while the Enrollment is open, and set with its end. */
  endReason: string | null;
}

const ENROLLMENT_COLUMNS = `id, school_id AS "schoolId", student_person_id AS "studentPersonId",
  started_at AS "startedAt", ended_at AS "endedAt", end_reason AS "endReason"`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Records an Enrollment open from now, or returns null when the Student already
 * holds one open. The unique index decides that, so two recorded at once
 * cannot both succeed.
 */
export async function recordEnrollment(
  transaction: Queryable,
  student: Person,
): Promise<Enrollment | null> {
  const { rows } = await transaction.query<Enrollment>(
    `INSERT INTO app.enrollment (school_id, student_person_id)
     VALUES ($1, $2)
     ON CONFLICT (school_id, student_person_id) WHERE ended_at IS NULL
     DO NOTHING
     RETURNING ${ENROLLMENT_COLUMNS}`,
    [student.schoolId, student.id],
  );
  return rows[0] ?? null;
}

/** The Enrollment with this identifier, in whichever School holds it, or null. */
export async function findEnrollment(
  database: Queryable,
  enrollmentId: string,
): Promise<Enrollment | null> {
  if (!UUID.test(enrollmentId)) {
    return null;
  }
  const { rows } = await database.query<Enrollment>(
    `SELECT ${ENROLLMENT_COLUMNS} FROM app.enrollment WHERE id = $1`,
    [enrollmentId],
  );
  return rows[0] ?? null;
}

/**
 * Locks an Enrollment until the transaction ends, so ending it cannot interleave
 * with another change to it or with a Guardian being linked to its Student, and
 * returns it as it now stands.
 *
 * Only for an Enrollment the caller has already been permitted to change, for
 * the reason given at lockMembership.
 */
export async function lockEnrollment(
  transaction: Queryable,
  enrollment: Enrollment,
): Promise<Enrollment> {
  const { rows } = await transaction.query<Enrollment>(
    `SELECT ${ENROLLMENT_COLUMNS} FROM app.enrollment
     WHERE school_id = $1 AND id = $2
     FOR UPDATE`,
    [enrollment.schoolId, enrollment.id],
  );
  return rows[0]!;
}

/**
 * Whether the Student holds an open Enrollment, holding it open until the
 * transaction ends: ending it waits, and then finds whatever this transaction
 * went on to write. A Guardian link made under this cannot miss the ending
 * that should end it.
 */
export async function lockOpenEnrollment(transaction: Queryable, student: Person): Promise<boolean> {
  const { rows } = await transaction.query(
    `SELECT 1 FROM app.enrollment
     WHERE school_id = $1 AND student_person_id = $2 AND ended_at IS NULL
     FOR SHARE`,
    [student.schoolId, student.id],
  );
  return rows.length > 0;
}

/** Ends an Enrollment now, for this reason. The row stays, as the Student's history. */
export async function endEnrollmentNow(
  transaction: Queryable,
  enrollmentId: string,
  reason: string,
): Promise<Enrollment> {
  const { rows } = await transaction.query<Enrollment>(
    `UPDATE app.enrollment SET ended_at = now(), end_reason = $2
     WHERE id = $1
     RETURNING ${ENROLLMENT_COLUMNS}`,
    [enrollmentId, reason],
  );
  return rows[0]!;
}

/** Whether the Student holds an open Enrollment at this moment. */
export async function hasOpenEnrollment(database: Queryable, student: Person): Promise<boolean> {
  const { rows } = await database.query<{ open: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM app.enrollment
       WHERE school_id = $1 AND student_person_id = $2 AND ended_at IS NULL
     ) AS open`,
    [student.schoolId, student.id],
  );
  return rows[0]!.open;
}

/**
 * The Student's own Enrollment as it now stands: the one open, or the last to
 * have ended when none is, and null for a Person never enrolled.
 *
 * Open ones sort first, then the latest ending, so a Student who left and
 * returned is described by the stay they are in rather than by an older one.
 */
export async function currentEnrollmentOf(
  database: Queryable,
  student: Person,
): Promise<Enrollment | null> {
  const { rows } = await database.query<Enrollment>(
    `SELECT ${ENROLLMENT_COLUMNS} FROM app.enrollment
     WHERE school_id = $1 AND student_person_id = $2
     ORDER BY ended_at IS NOT NULL, ended_at DESC, started_at DESC
     LIMIT 1`,
    [student.schoolId, student.id],
  );
  return rows[0] ?? null;
}

/** Every Enrollment in the School, ended ones included, oldest first. */
export async function enrollmentsInSchool(
  database: Queryable,
  schoolId: string,
): Promise<Enrollment[]> {
  const { rows } = await database.query<Enrollment>(
    `SELECT ${ENROLLMENT_COLUMNS} FROM app.enrollment
     WHERE school_id = $1
     ORDER BY started_at, id`,
    [schoolId],
  );
  return rows;
}
