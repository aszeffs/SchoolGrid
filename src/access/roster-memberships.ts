import { withConstraintsNamed } from "../academic-structure/constraints.ts";
import type { SchoolDate } from "../calendar/index.ts";
import type { Queryable } from "../db/transaction.ts";
import type { Person } from "../identity/index.ts";

/**
 * Roster memberships as stored. Each is one Student's participation in one
 * Class Offering, bounded by School dates inside its Term (ADR-0011); a Person
 * rostered twice in one offering holds two rows that never overlap
 * (migrations/0017). One that has begun is ended rather than deleted, as the
 * record of who was in the class and when.
 *
 * Nothing here decides whether anyone may see or change a membership: that is
 * the decision in ./index.ts, made before any of this is reached.
 */
export interface RosterMembership {
  id: string;
  schoolId: string;
  classOfferingId: string;
  personId: string;
  firstDate: SchoolDate;
  /** Null while it is open: it runs to the end of its Term. */
  lastDate: SchoolDate | null;
}

/** One membership a change made, removed, or altered: `before` is null for one made, `after` for one removed. */
export interface ChangedRosterMembership {
  before: RosterMembership | null;
  after: RosterMembership | null;
}

const COLUMNS = `m.id, m.school_id AS "schoolId", m.class_offering_id AS "classOfferingId",
  m.student_person_id AS "personId", to_char(m.first_date, 'YYYY-MM-DD') AS "firstDate",
  to_char(m.last_date, 'YYYY-MM-DD') AS "lastDate"`;

/**
 * The last School date a membership aliased `m` runs to, open or not: an open
 * one runs to the end of its Term. Needs its Term joined as `t`.
 */
const RUNS_TO = `coalesce(m.last_date, t.last_date)`;

const WITH_TERM = `app.roster_membership m
  JOIN app.class_offering o ON o.school_id = m.school_id AND o.id = m.class_offering_id
  JOIN app.term t ON t.school_id = o.school_id AND t.id = o.term_id`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The rules the database holds for a membership's own bounds, as the Conflicts they stand for. */
const BOUNDS_CONFLICTS = {
  roster_membership_no_overlap: { conflict: "roster_membership_overlap" },
  roster_membership_inside_term: { conflict: "roster_membership_outside_term" },
} as const;

/** Every membership of these Class Offerings, ended ones included. */
export async function rosterMembershipsOn(
  database: Queryable,
  classOfferingIds: readonly string[],
): Promise<RosterMembership[]> {
  const { rows } = await database.query<RosterMembership>(
    `SELECT ${COLUMNS} FROM app.roster_membership m
     WHERE m.class_offering_id = ANY($1::uuid[])
     ORDER BY m.first_date, m.id`,
    [classOfferingIds],
  );
  return rows;
}

/** Every membership this Person holds, ended ones included. */
export async function rosterMembershipsOf(
  database: Queryable,
  person: Pick<Person, "id" | "schoolId">,
): Promise<RosterMembership[]> {
  const { rows } = await database.query<RosterMembership>(
    `SELECT ${COLUMNS} FROM app.roster_membership m
     WHERE m.school_id = $1 AND m.student_person_id = $2
     ORDER BY m.first_date, m.id`,
    [person.schoolId, person.id],
  );
  return rows;
}

/** The membership with this identifier, in whichever School holds it, or null. */
export async function findRosterMembership(
  database: Queryable,
  rosterMembershipId: string,
): Promise<RosterMembership | null> {
  if (!UUID.test(rosterMembershipId)) {
    return null;
  }
  const { rows } = await database.query<RosterMembership>(
    `SELECT ${COLUMNS} FROM app.roster_membership m WHERE m.id = $1`,
    [rosterMembershipId],
  );
  return rows[0] ?? null;
}

/**
 * Locks a membership until the transaction ends, and returns it as it now
 * stands with the last School date of its Term, or null if it was deleted since
 * it was found. Only for a membership the caller has already been permitted to
 * change: see lockPermittedMembership in ./roster-membership-routes.ts.
 */
export async function lockRosterMembership(
  transaction: Queryable,
  membership: RosterMembership,
): Promise<(RosterMembership & { termLastDate: SchoolDate }) | null> {
  const { rows } = await transaction.query<RosterMembership & { termLastDate: SchoolDate }>(
    `SELECT ${COLUMNS}, to_char(t.last_date, 'YYYY-MM-DD') AS "termLastDate"
     FROM ${WITH_TERM}
     WHERE m.school_id = $1 AND m.id = $2
     FOR UPDATE OF m`,
    [membership.schoolId, membership.id],
  );
  return rows[0] ?? null;
}

/**
 * Rosters a Person in a Class Offering, or refuses bounds that overlap one of
 * their own memberships of it or fall outside its Term. Whether the Person may
 * be rostered at all is the caller's to have checked.
 */
export async function rosterStudent(
  transaction: Queryable,
  membership: Omit<RosterMembership, "id">,
): Promise<RosterMembership> {
  const { rows } = await withConstraintsNamed(BOUNDS_CONFLICTS, () =>
    transaction.query<RosterMembership>(
      `INSERT INTO app.roster_membership AS m (school_id, class_offering_id, student_person_id, first_date, last_date)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLUMNS}`,
      [membership.schoolId, membership.classOfferingId, membership.personId, membership.firstDate, membership.lastDate],
    ),
  );
  return rows[0]!;
}

/**
 * Moves a locked membership's bounds, refusing them as rostering would. Returns
 * it as it was and as it is, or null when the change states what it holds.
 */
export async function setRosterMembershipBounds(
  transaction: Queryable,
  membership: RosterMembership,
  { firstDate, lastDate }: { firstDate: SchoolDate; lastDate: SchoolDate | null },
): Promise<ChangedRosterMembership | null> {
  if (firstDate === membership.firstDate && lastDate === membership.lastDate) {
    return null;
  }
  const { rows } = await withConstraintsNamed(BOUNDS_CONFLICTS, () =>
    transaction.query<RosterMembership>(
      `UPDATE app.roster_membership AS m SET first_date = $3, last_date = $4
       WHERE m.school_id = $1 AND m.id = $2
       RETURNING ${COLUMNS}`,
      [membership.schoolId, membership.id, firstDate, lastDate],
    ),
  );
  return { before: membership, after: rows[0]! };
}

/** Deletes a locked membership. Only one that has not begun is deleted: see the grant in migrations/0017. */
export async function deleteRosterMembership(transaction: Queryable, membership: RosterMembership): Promise<void> {
  await transaction.query(`DELETE FROM app.roster_membership WHERE school_id = $1 AND id = $2`, [
    membership.schoolId,
    membership.id,
  ]);
}

/**
 * Ends every membership of this Person's still running after this School date:
 * on that date, or, for one that would only have begun after it, by deleting
 * it, since it never began. Returns each as it was and as it is.
 *
 * What ending an Enrollment does, in the transaction that ends it (CONTEXT.md:
 * Enrollment).
 */
export async function endRosterMembershipsOf(
  transaction: Queryable,
  person: Pick<Person, "id" | "schoolId">,
  endsOn: SchoolDate,
): Promise<ChangedRosterMembership[]> {
  const { rows } = await transaction.query<RosterMembership>(
    `SELECT ${COLUMNS} FROM ${WITH_TERM}
     WHERE m.school_id = $1 AND m.student_person_id = $2 AND ${RUNS_TO} > $3
     ORDER BY m.first_date, m.id
     FOR UPDATE OF m`,
    [person.schoolId, person.id, endsOn],
  );
  const changed: ChangedRosterMembership[] = [];
  for (const membership of rows) {
    if (membership.firstDate > endsOn) {
      await deleteRosterMembership(transaction, membership);
      changed.push({ before: membership, after: null });
    } else {
      // Inside the Term still: it begins no later than this date, and ran past it.
      changed.push((await setRosterMembershipBounds(transaction, membership, { ...membership, lastDate: endsOn }))!);
    }
  }
  return changed;
}

/** How many of this Person's memberships ending their Enrollment on this School date would end. */
export async function countRosterMembershipsRunningPast(
  database: Queryable,
  person: Pick<Person, "id" | "schoolId">,
  endsOn: SchoolDate,
): Promise<number> {
  const { rows } = await database.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${WITH_TERM}
     WHERE m.school_id = $1 AND m.student_person_id = $2 AND ${RUNS_TO} > $3`,
    [person.schoolId, person.id, endsOn],
  );
  return rows[0]!.count;
}

/** The Class Offerings this Person was ever rostered in, whether or not the membership has ended. */
export async function classOfferingIdsRosteredIn(database: Queryable, person: Person): Promise<Set<string>> {
  const { rows } = await database.query<{ classOfferingId: string }>(
    `SELECT DISTINCT class_offering_id AS "classOfferingId" FROM app.roster_membership
     WHERE school_id = $1 AND student_person_id = $2`,
    [person.schoolId, person.id],
  );
  return new Set(rows.map((row) => row.classOfferingId));
}
