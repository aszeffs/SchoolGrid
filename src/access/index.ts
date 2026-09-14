import type { UserAccount } from "../authentication/index.ts";
import type { Queryable } from "../db/transaction.ts";
import { personFor, schoolsReachedBy, type Person, type School } from "../identity/index.ts";
import {
  activeRoles,
  schoolIdsWithActiveMembership,
  type Membership,
  type Role,
} from "./memberships.ts";

/**
 * The Access module is the sole authority on whether an actor may do something
 * to a target. It owns School memberships, and nothing outside it reads one: an
 * Actor's roles are kept here rather than on the Actor, so a handler holding an
 * Actor can ask this module for a decision but cannot make the decision itself.
 */
export { grantMembership, ROLES, type Membership, type Role } from "./memberships.ts";

/**
 * Why a request was refused. It is written to the Audit record, where a School
 * Administrator can investigate it, and never reaches the caller: see `refuse`
 * in http/refusal.ts.
 */
export type RefusalReason =
  | "unauthenticated"
  | "no-person-in-school"
  | "no-active-membership"
  | "no-such-route"
  | "malformed-url"
  | "absent"
  | "outside-school"
  | "forbidden";

/** What a refused request asked for, as the caller named it. */
export interface RefusedTarget {
  type: string;
  id: string;
}

export class Refused extends Error {
  /**
   * The target is omitted when the refusal came before any target was looked
   * at, and the request itself is then what was refused. The caller's Person
   * is given when the refusal came before they could become an Actor, but the
   * School already knows who they are.
   */
  constructor(
    readonly reason: RefusalReason,
    readonly target?: RefusedTarget,
    readonly callerPerson?: Person,
  ) {
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

/**
 * Resolves a caller to an Actor in one School, or refuses. A caller with no
 * Person in the School is refused for the same reason-free response as one
 * with no account at all, so an account reveals nothing about Schools it does
 * not reach — including whether they exist.
 *
 * All access flows from memberships held at this moment. A Person whose every
 * membership has ended, or not yet begun, is refused here, before any handler
 * runs: departure leaves no access to the School at all, not even to their own
 * Person.
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
  const roles = await activeRoles(database, person);
  if (roles.size === 0) {
    throw new Refused("no-active-membership", undefined, person);
  }
  const actor: Actor = Object.freeze({ person, schoolId: person.schoolId });
  rolesOf.set(actor, roles);
  return actor;
}

/** The Schools this account can act in: those where its Person holds a membership now. */
export async function reachableSchools(
  database: Queryable,
  account: UserAccount,
): Promise<School[]> {
  const schools = await schoolsReachedBy(database, account.id);
  const active = await schoolIdsWithActiveMembership(database, account.id);
  return schools.filter((school) => active.has(school.id));
}

function holds(actor: Actor, role: Role): boolean {
  return rolesOf.get(actor)?.has(role) ?? false;
}

/**
 * Why a target is out of the actor's School, whatever their roles, or null when
 * it is in it.
 */
function outOfReach(actor: Actor, target: { schoolId: string } | null): RefusalReason | null {
  if (target === null) {
    return "absent";
  }
  if (target.schoolId !== actor.schoolId) {
    return "outside-school";
  }
  return null;
}

/** The one decision: null when permitted, otherwise why not. */
function decideReadPerson(actor: Actor, target: Person | null): RefusalReason | null {
  const unreachable = outOfReach(actor, target);
  if (unreachable !== null) {
    return unreachable;
  }
  if (target!.id === actor.person.id || holds(actor, "school_administrator")) {
    return null;
  }
  return "forbidden";
}

/**
 * Returns the target if the actor may read it, and refuses otherwise. The
 * requested identifier is what the refusal names, since an absent target has
 * no identifier of its own.
 */
export function authorizeReadPerson(actor: Actor, personId: string, target: Person | null): Person {
  const reason = decideReadPerson(actor, target);
  if (reason !== null) {
    throw new Refused(reason, { type: "person", id: personId });
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
    throw new Refused("forbidden", { type: "school", id: actor.schoolId });
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

/**
 * Returns the School whose memberships the actor may list and grant in, and
 * refuses otherwise. Only a School Administrator manages memberships, and only
 * in the School they are acting in.
 *
 * Asked before a request's body is read, so a caller who may not manage
 * memberships is refused whatever they sent, and never learns that a body was
 * wrong.
 */
export function authorizeManageMemberships(actor: Actor): string {
  const reason = decideManageMemberships(actor, { schoolId: actor.schoolId });
  if (reason !== null) {
    throw new Refused(reason, { type: "school", id: actor.schoolId });
  }
  return actor.schoolId;
}

/** The one decision for memberships: null when permitted, otherwise why not. */
function decideManageMemberships(
  actor: Actor,
  target: { schoolId: string } | null,
): RefusalReason | null {
  return outOfReach(actor, target) ?? (holds(actor, "school_administrator") ? null : "forbidden");
}

/** Returns the Person the actor may grant a membership to, and refuses otherwise. */
export function authorizeGrantMembershipTo(
  actor: Actor,
  personId: string,
  target: Person | null,
): Person {
  const reason = decideManageMemberships(actor, target);
  if (reason !== null) {
    throw new Refused(reason, { type: "person", id: personId });
  }
  return target!;
}

/** Returns the membership the actor may change or revoke, and refuses otherwise. */
export function authorizeManageMembership(
  actor: Actor,
  membershipId: string,
  target: Membership | null,
): Membership {
  const reason = decideManageMemberships(actor, target);
  if (reason !== null) {
    throw new Refused(reason, { type: "membership", id: membershipId });
  }
  return target!;
}
