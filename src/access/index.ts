import type { UserAccount } from "../authentication/index.ts";
import type { Queryable } from "../db/transaction.ts";
import { personFor, type Person } from "../identity/index.ts";

/**
 * The Access module is the sole authority on whether an actor may do something
 * to a target. It owns School memberships, and nothing outside it reads one: an
 * Actor's roles are kept here rather than on the Actor, so a handler holding an
 * Actor can ask this module for a decision but cannot make the decision itself.
 */
export type Role = "school_administrator";

/**
 * Why a request was refused. It exists for the log (and, from ticket 05, the
 * Audit record). It never reaches the caller: see `refuse` in http/refusal.ts.
 */
export type RefusalReason =
  | "unauthenticated"
  | "no-person-in-school"
  | "absent"
  | "outside-school"
  | "forbidden";

export class Refused extends Error {
  constructor(readonly reason: RefusalReason) {
    super(`refused: ${reason}`);
  }
}

/** A caller resolved to their Person within the School they are acting in. */
export interface Actor {
  readonly person: Person;
  readonly schoolId: string;
}

// Keyed by the Actor object this module handed out. An Actor built anywhere
// else holds no roles, so it can be granted no more than its own Person.
const rolesOf = new WeakMap<Actor, ReadonlySet<Role>>();

export async function grantMembership(
  database: Queryable,
  { person, role }: { person: Person; role: Role },
): Promise<void> {
  await database.query(
    `INSERT INTO app.school_membership (school_id, person_id, role) VALUES ($1, $2, $3)`,
    [person.schoolId, person.id, role],
  );
}

/**
 * Resolves a caller to an Actor in one School, or refuses. A caller with no
 * Person in the School is refused for the same reason-free response as one
 * with no account at all, so an account reveals nothing about Schools it does
 * not reach — including whether they exist.
 */
export async function resolveActor(
  database: Queryable,
  account: UserAccount | null,
  schoolId: string,
): Promise<Actor> {
  if (account === null) {
    throw new Refused("unauthenticated");
  }
  const person = await personFor(database, { userAccountId: account.id, schoolId });
  if (person === null) {
    throw new Refused("no-person-in-school");
  }
  const { rows } = await database.query<{ role: Role }>(
    `SELECT role FROM app.school_membership WHERE school_id = $1 AND person_id = $2`,
    [person.schoolId, person.id],
  );
  const actor: Actor = Object.freeze({ person, schoolId: person.schoolId });
  rolesOf.set(actor, new Set(rows.map((row) => row.role)));
  return actor;
}

function holds(actor: Actor, role: Role): boolean {
  return rolesOf.get(actor)?.has(role) ?? false;
}

/** The one decision: null when permitted, otherwise why not. */
function decideReadPerson(actor: Actor, target: Person | null): RefusalReason | null {
  if (target === null) {
    return "absent";
  }
  if (target.schoolId !== actor.schoolId) {
    return "outside-school";
  }
  if (target.id === actor.person.id || holds(actor, "school_administrator")) {
    return null;
  }
  return "forbidden";
}

/** Returns the target if the actor may read it, and refuses otherwise. */
export function authorizeReadPerson(actor: Actor, target: Person | null): Person {
  const reason = decideReadPerson(actor, target);
  if (reason !== null) {
    throw new Refused(reason);
  }
  return target!;
}

/**
 * Returns the School whose Audit records the actor may read, and refuses
 * otherwise. Only a School Administrator reads Audit records, and only those of
 * the School they are acting in: an Actor exists in exactly one School, so
 * there is no other School this could return.
 */
export function authorizeReadAuditRecords(actor: Actor): string {
  if (!holds(actor, "school_administrator")) {
    throw new Refused("forbidden");
  }
  return actor.schoolId;
}

/**
 * The Persons among these that the actor may read. The rest are omitted, not
 * redacted or flagged, so a listing cannot be used to count what is withheld.
 */
export function readablePersons(actor: Actor, persons: readonly Person[]): Person[] {
  return persons.filter((person) => decideReadPerson(actor, person) === null);
}
