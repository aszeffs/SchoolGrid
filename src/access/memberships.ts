import type { Queryable } from "../db/transaction.ts";
import type { Person } from "../identity/index.ts";

/**
 * School memberships as stored. Each is one role, held by one Person, between
 * its own bounds; a Person holding several holds several rows with nothing
 * linking them. Rows are never deleted or rewritten, only ended, so the table
 * is also the record of who held what and when (migrations/0005).
 *
 * Nothing here decides whether anyone may see or change a membership: that is
 * the decision in ./index.ts, made before any of this is reached.
 */
export const ROLES = ["school_administrator", "faculty", "student", "guardian"] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return (ROLES as readonly unknown[]).includes(value);
}

export interface Membership {
  id: string;
  schoolId: string;
  personId: string;
  role: Role;
  startsAt: Date;
  /** Null while the relationship has no end. */
  endsAt: Date | null;
}

const MEMBERSHIP_COLUMNS = `id, school_id AS "schoolId", person_id AS "personId", role,
  starts_at AS "startsAt", ends_at AS "endsAt"`;

/** Whether the membership row aliased `alias` grants anything at this moment. */
function isActive(alias: string): string {
  return `${alias}.starts_at <= now() AND (${alias}.ends_at IS NULL OR ${alias}.ends_at > now())`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Records a membership. A missing start is now. Whether the bounds are ones a
 * School Administrator may choose is decided by the caller: provisioning and
 * test fixtures may set any the table accepts.
 */
export async function grantMembership(
  database: Queryable,
  {
    person,
    role,
    startsAt,
    endsAt,
  }: { person: Person; role: Role; startsAt?: Date | undefined; endsAt?: Date | null | undefined },
): Promise<Membership> {
  const { rows } = await database.query<Membership>(
    `INSERT INTO app.school_membership (school_id, person_id, role, starts_at, ends_at)
     VALUES ($1, $2, $3, COALESCE($4, now()), $5)
     RETURNING ${MEMBERSHIP_COLUMNS}`,
    [person.schoolId, person.id, role, startsAt ?? null, endsAt ?? null],
  );
  return rows[0]!;
}

/** Every membership in the School, ended ones included, oldest first. */
export async function membershipsInSchool(
  database: Queryable,
  schoolId: string,
): Promise<Membership[]> {
  const { rows } = await database.query<Membership>(
    `SELECT ${MEMBERSHIP_COLUMNS} FROM app.school_membership
     WHERE school_id = $1
     ORDER BY created_at, id`,
    [schoolId],
  );
  return rows;
}

/** Whether a membership is over: its end has passed, or it was revoked before it began. */
export function hasEnded({ startsAt, endsAt }: Membership, now: Date): boolean {
  return endsAt !== null && (endsAt <= now || endsAt <= startsAt);
}

/** The membership with this identifier, in whichever School holds it, or null. */
export async function findMembership(
  database: Queryable,
  membershipId: string,
): Promise<Membership | null> {
  if (!UUID.test(membershipId)) {
    return null;
  }
  const { rows } = await database.query<Membership>(
    `SELECT ${MEMBERSHIP_COLUMNS} FROM app.school_membership WHERE id = $1`,
    [membershipId],
  );
  return rows[0] ?? null;
}

/**
 * Locks a membership until the transaction ends, so two changes to it cannot
 * interleave, and returns it as it now stands.
 *
 * Only for a membership the caller has already been permitted to change. A
 * lock taken before that decision would make a request for another School's
 * membership wait on it, while one for an absent membership returned at once:
 * a difference in timing that ADR-0002 forbids as much as one in the response.
 */
export async function lockMembership(
  transaction: Queryable,
  membership: Membership,
): Promise<Membership> {
  const { rows } = await transaction.query<Membership>(
    `SELECT ${MEMBERSHIP_COLUMNS} FROM app.school_membership
     WHERE school_id = $1 AND id = $2
     FOR UPDATE`,
    [membership.schoolId, membership.id],
  );
  return rows[0]!;
}

/**
 * Whether the Person already holds this role for any of the time between these
 * bounds, counting memberships not yet begun. Two such rows would make
 * revoking "the" membership leave the role in force through the other.
 *
 * Takes a lock on the Person's memberships of this role until the transaction
 * ends, so two grants made at once cannot both find nothing and both insert.
 */
export async function holdsRoleDuring(
  transaction: Queryable,
  { person, role, startsAt, endsAt }: { person: Person; role: Role; startsAt: Date; endsAt: Date | null },
): Promise<boolean> {
  await transaction.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `school_membership:${person.id}:${role}`,
  ]);
  const { rows } = await transaction.query<{ held: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM app.school_membership
       WHERE school_id = $1 AND person_id = $2 AND role = $3
         AND (ends_at IS NULL OR (ends_at > starts_at AND ends_at > $4))
         AND ($5::timestamptz IS NULL OR starts_at < $5)
     ) AS held`,
    [person.schoolId, person.id, role, startsAt, endsAt],
  );
  return rows[0]!.held;
}

/** Moves a membership's end. Its start, role, and Person never change. */
export async function setMembershipEnd(
  transaction: Queryable,
  membershipId: string,
  endsAt: Date | null,
): Promise<Membership> {
  const { rows } = await transaction.query<Membership>(
    `UPDATE app.school_membership SET ends_at = $2 WHERE id = $1 RETURNING ${MEMBERSHIP_COLUMNS}`,
    [membershipId, endsAt],
  );
  return rows[0]!;
}

/**
 * Ends a membership now. One that has not begun ends at its start, so it never
 * grants anything and its bounds stay in order.
 */
export async function endMembershipNow(
  transaction: Queryable,
  membershipId: string,
): Promise<Membership> {
  const { rows } = await transaction.query<Membership>(
    `UPDATE app.school_membership SET ends_at = GREATEST(starts_at, now())
     WHERE id = $1
     RETURNING ${MEMBERSHIP_COLUMNS}`,
    [membershipId],
  );
  return rows[0]!;
}

/** The roles this Person holds at this moment. */
export async function activeRoles(database: Queryable, person: Person): Promise<Set<Role>> {
  const { rows } = await database.query<{ role: Role }>(
    `SELECT role FROM app.school_membership membership
     WHERE school_id = $1 AND person_id = $2 AND ${isActive("membership")}`,
    [person.schoolId, person.id],
  );
  return new Set(rows.map((row) => row.role));
}

/** The Schools in which this User account's Person holds a membership at this moment. */
export async function schoolIdsWithActiveMembership(
  database: Queryable,
  userAccountId: string,
): Promise<Set<string>> {
  const { rows } = await database.query<{ schoolId: string }>(
    `SELECT DISTINCT membership.school_id AS "schoolId"
     FROM app.school_membership membership
     JOIN app.person person
       ON person.school_id = membership.school_id AND person.id = membership.person_id
     WHERE person.user_account_id = $1 AND ${isActive("membership")}`,
    [userAccountId],
  );
  return new Set(rows.map((row) => row.schoolId));
}
