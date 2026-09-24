import { withConstraintsNamed } from "../academic-structure/constraints.ts";
import type { SchoolDate } from "../calendar/index.ts";
import type { Queryable } from "../db/transaction.ts";
import type { Person } from "../identity/index.ts";

/**
 * Teaching assignments as stored. Each is one Faculty member's assignment to
 * one Class Offering, bounded by School dates inside its Term (ADR-0011); a
 * Person assigned twice to one offering holds two rows that never overlap
 * (migrations/0016). One that has begun is ended rather than deleted, as the
 * record of who taught what and when.
 *
 * Nothing here decides whether anyone may see or change an assignment: that is
 * the decision in ./index.ts, made before any of this is reached.
 */
export interface TeachingAssignment {
  id: string;
  schoolId: string;
  classOfferingId: string;
  personId: string;
  firstDate: SchoolDate;
  /** Null while it is open: it runs to the end of its Term. */
  lastDate: SchoolDate | null;
}

/** One assignment a change made, removed, or altered: `before` is null for one made, `after` for one removed. */
export interface ChangedAssignment {
  before: TeachingAssignment | null;
  after: TeachingAssignment | null;
}

const COLUMNS = `a.id, a.school_id AS "schoolId", a.class_offering_id AS "classOfferingId",
  a.faculty_person_id AS "personId", to_char(a.first_date, 'YYYY-MM-DD') AS "firstDate",
  to_char(a.last_date, 'YYYY-MM-DD') AS "lastDate"`;

/**
 * The last School date an assignment aliased `a` runs to, open or not: an open
 * one runs to the end of its Term. Needs its offering joined as `o` and its
 * Term as `t`.
 */
const RUNS_TO = `coalesce(a.last_date, t.last_date)`;

const WITH_TERM = `app.teaching_assignment a
  JOIN app.class_offering o ON o.school_id = a.school_id AND o.id = a.class_offering_id
  JOIN app.term t ON t.school_id = o.school_id AND t.id = o.term_id`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The rules the database holds for an assignment's own bounds, as the Conflicts they stand for. */
const BOUNDS_CONFLICTS = {
  teaching_assignment_no_overlap: { conflict: "teaching_assignment_overlap" },
  teaching_assignment_inside_term: { conflict: "teaching_assignment_outside_term" },
} as const;

/** Every assignment to these Class Offerings, ended ones included. */
export async function teachingAssignmentsOn(
  database: Queryable,
  classOfferingIds: readonly string[],
): Promise<TeachingAssignment[]> {
  const { rows } = await database.query<TeachingAssignment>(
    `SELECT ${COLUMNS} FROM app.teaching_assignment a
     WHERE a.class_offering_id = ANY($1::uuid[])
     ORDER BY a.first_date, a.id`,
    [classOfferingIds],
  );
  return rows;
}

/** The assignment with this identifier, in whichever School holds it, or null. */
export async function findTeachingAssignment(
  database: Queryable,
  teachingAssignmentId: string,
): Promise<TeachingAssignment | null> {
  if (!UUID.test(teachingAssignmentId)) {
    return null;
  }
  const { rows } = await database.query<TeachingAssignment>(
    `SELECT ${COLUMNS} FROM app.teaching_assignment a WHERE a.id = $1`,
    [teachingAssignmentId],
  );
  return rows[0] ?? null;
}

/**
 * Locks an assignment until the transaction ends, and returns it as it now
 * stands with the last School date of its Term, or null if it was deleted since
 * it was found. Only for an assignment the caller has already been permitted to
 * change: see lockMembership.
 */
export async function lockTeachingAssignment(
  transaction: Queryable,
  assignment: TeachingAssignment,
): Promise<(TeachingAssignment & { termLastDate: SchoolDate }) | null> {
  const { rows } = await transaction.query<TeachingAssignment & { termLastDate: SchoolDate }>(
    `SELECT ${COLUMNS}, to_char(t.last_date, 'YYYY-MM-DD') AS "termLastDate"
     FROM ${WITH_TERM}
     WHERE a.school_id = $1 AND a.id = $2
     FOR UPDATE OF a`,
    [assignment.schoolId, assignment.id],
  );
  return rows[0] ?? null;
}

/**
 * Assigns a Person to a Class Offering, or refuses bounds that overlap one of
 * their own assignments to it or fall outside its Term. Whether the Person may
 * be assigned at all is the caller's to have checked.
 */
export async function assignTeaching(
  transaction: Queryable,
  assignment: Omit<TeachingAssignment, "id">,
): Promise<TeachingAssignment> {
  const { rows } = await withConstraintsNamed(BOUNDS_CONFLICTS, () =>
    transaction.query<TeachingAssignment>(
      `INSERT INTO app.teaching_assignment AS a (school_id, class_offering_id, faculty_person_id, first_date, last_date)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLUMNS}`,
      [assignment.schoolId, assignment.classOfferingId, assignment.personId, assignment.firstDate, assignment.lastDate],
    ),
  );
  return rows[0]!;
}

/**
 * Moves a locked assignment's bounds, refusing them as assigning would. Returns
 * it as it was and as it is, or null when the change states what it holds.
 */
export async function setTeachingAssignmentBounds(
  transaction: Queryable,
  assignment: TeachingAssignment,
  { firstDate, lastDate }: { firstDate: SchoolDate; lastDate: SchoolDate | null },
): Promise<ChangedAssignment | null> {
  if (firstDate === assignment.firstDate && lastDate === assignment.lastDate) {
    return null;
  }
  const { rows } = await withConstraintsNamed(BOUNDS_CONFLICTS, () =>
    transaction.query<TeachingAssignment>(
      `UPDATE app.teaching_assignment AS a SET first_date = $3, last_date = $4
       WHERE a.school_id = $1 AND a.id = $2
       RETURNING ${COLUMNS}`,
      [assignment.schoolId, assignment.id, firstDate, lastDate],
    ),
  );
  return { before: assignment, after: rows[0]! };
}

/** Deletes a locked assignment. Only one that has not begun is deleted: see the grant in migrations/0016. */
export async function deleteTeachingAssignment(transaction: Queryable, assignment: TeachingAssignment): Promise<void> {
  await transaction.query(`DELETE FROM app.teaching_assignment WHERE school_id = $1 AND id = $2`, [
    assignment.schoolId,
    assignment.id,
  ]);
}

/**
 * Ends every assignment of this Person's still running after this School date:
 * on that date, or, for one that would only have begun after it, by deleting
 * it, since it never began. Returns each as it was and as it is.
 *
 * What ending a Faculty membership does, in the transaction that ends it
 * (CONTEXT.md: Teaching assignment).
 */
export async function endTeachingAssignmentsOf(
  transaction: Queryable,
  person: Pick<Person, "id" | "schoolId">,
  endsOn: SchoolDate,
): Promise<ChangedAssignment[]> {
  const { rows } = await transaction.query<TeachingAssignment>(
    `SELECT ${COLUMNS} FROM ${WITH_TERM}
     WHERE a.school_id = $1 AND a.faculty_person_id = $2 AND ${RUNS_TO} > $3
     ORDER BY a.first_date, a.id
     FOR UPDATE OF a`,
    [person.schoolId, person.id, endsOn],
  );
  const changed: ChangedAssignment[] = [];
  for (const assignment of rows) {
    if (assignment.firstDate > endsOn) {
      await deleteTeachingAssignment(transaction, assignment);
      changed.push({ before: assignment, after: null });
    } else {
      // Inside the Term still: it begins no later than this date, and ran past it.
      changed.push((await setTeachingAssignmentBounds(transaction, assignment, { ...assignment, lastDate: endsOn }))!);
    }
  }
  return changed;
}

/** How many of this Person's assignments ending their Faculty membership on this School date would end. */
export async function countTeachingAssignmentsRunningPast(
  database: Queryable,
  person: Pick<Person, "id" | "schoolId">,
  endsOn: SchoolDate,
): Promise<number> {
  const { rows } = await database.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${WITH_TERM}
     WHERE a.school_id = $1 AND a.faculty_person_id = $2 AND ${RUNS_TO} > $3`,
    [person.schoolId, person.id, endsOn],
  );
  return rows[0]!.count;
}

/** The Class Offerings this Person was ever assigned to, whether or not the assignment has ended. */
export async function classOfferingIdsTaughtBy(database: Queryable, person: Person): Promise<Set<string>> {
  const { rows } = await database.query<{ classOfferingId: string }>(
    `SELECT DISTINCT class_offering_id AS "classOfferingId" FROM app.teaching_assignment
     WHERE school_id = $1 AND faculty_person_id = $2`,
    [person.schoolId, person.id],
  );
  return new Set(rows.map((row) => row.classOfferingId));
}

/**
 * The Class Offerings this Person was ever assigned to, each with whether any
 * of their assignments to it still runs on or after this School date.
 */
export async function classOfferingsTaughtBy(
  database: Queryable,
  person: Person,
  today: SchoolDate,
): Promise<Map<string, { current: boolean }>> {
  const { rows } = await database.query<{ classOfferingId: string; current: boolean }>(
    `SELECT a.class_offering_id AS "classOfferingId", bool_or(${RUNS_TO} >= $3) AS current
     FROM ${WITH_TERM}
     WHERE a.school_id = $1 AND a.faculty_person_id = $2
     GROUP BY a.class_offering_id`,
    [person.schoolId, person.id, today],
  );
  return new Map(rows.map(({ classOfferingId, current }) => [classOfferingId, { current }]));
}
