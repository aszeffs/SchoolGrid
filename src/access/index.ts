import type { Authentication, UserAccount } from "../authentication/index.ts";
import type { Queryable } from "../db/transaction.ts";
import {
  personFor,
  platformAdministratorFor,
  schoolsReachedBy,
  type ListedPerson,
  type Person,
  type PlatformAdministrator,
  type School,
} from "../identity/index.ts";
import { invitationState, type Invitation, type InvitationState } from "../identity/invitations.ts";
import { hasOpenEnrollment, type Enrollment } from "./enrollments.ts";
import { linkedStudentIds, type GuardianLink } from "./guardian-links.ts";
import {
  activeRoles,
  schoolIdsWithActiveMembership,
  type Membership,
  type Role,
} from "./memberships.ts";

/**
 * The Access module is the sole authority on whether an actor may do something
 * to a target. It owns School memberships, Guardian links, and Enrollments, and
 * nothing outside it reads one: an Actor's roles, links, and Enrollment are kept
 * here rather than on the Actor, so a handler holding an Actor can ask this
 * module for a decision but cannot make the decision itself.
 */
export { grantMembership, ROLES, type Membership, type Role } from "./memberships.ts";
export { recordEnrollment, type Enrollment } from "./enrollments.ts";
export type { AccessProfile, GuardianLink } from "./guardian-links.ts";

/**
 * Why a request was refused. It is written to the Audit record, where a School
 * Administrator can investigate it, and never reaches the caller: see `refuse`
 * in http/refusal.ts.
 */
export type RefusalReason =
  | "unauthenticated"
  | "cross-origin"
  | "ambiguous-session"
  | "no-person-in-school"
  | "no-active-membership"
  | "no-such-route"
  | "malformed-url"
  | "absent"
  | "outside-school"
  | "forbidden"
  | "not-platform-administrator"
  | "platform-administrator"
  | "claimed"
  | "revoked"
  | "redeemed"
  | "expired"
  /** An account redeeming an Invitation into a School where it already resolves to a Person. */
  | "duplicate-person";

/** What a refused request asked for, as the caller named it. */
export interface RefusedTarget {
  type: string;
  id: string;
}

/**
 * Who a caller refused before becoming an Actor is, when that is already
 * known: a Person the School holds, or a Platform Administrator.
 */
export type RefusedCaller = { person: Person } | { platformAdministrator: PlatformAdministrator };

export class Refused extends Error {
  /**
   * The target is omitted when the refusal came before any target was looked
   * at, and the request itself is then what was refused. The caller is given
   * when the refusal came before they could become an Actor, but who they are
   * is already known.
   */
  constructor(
    readonly reason: RefusalReason,
    readonly target?: RefusedTarget,
    readonly caller?: RefusedCaller,
  ) {
    super(`refused: ${reason}`);
  }
}

/** A caller resolved to their Person within the School they are acting in. */
export interface Actor {
  readonly person: Person;
  readonly schoolId: string;
}

/** What an Actor holds at the moment they were resolved. */
interface Standing {
  roles: ReadonlySet<Role>;
  /** The Students linked to the Actor as a Guardian, while that membership is in force. */
  linkedStudentIds: ReadonlySet<string>;
  /**
   * Whether the Actor, as a Student, holds an open Enrollment. Looked up on every
   * request and never stored: a Student's access is full while an Enrollment is
   * open and narrowed once none is, so it narrows on departure and widens on
   * return with nothing written to say so.
   */
  enrolled: boolean;
}

// Keyed by the Actor object this module handed out. An Actor built anywhere
// else holds no standing, so it can be granted no more than its own Person.
const standingOf = new WeakMap<Actor, Standing>();

/**
 * Resolves a caller to an Actor in one School, or refuses. A caller with no
 * Person in the School is refused for the same reason-free response as one
 * with no account at all, so an account reveals nothing about Schools it does
 * not reach — including whether they exist.
 *
 * A Platform Administrator is refused in every School before their account is
 * even resolved to a Person. They hold no School membership, and a Person
 * their account resolves to, however it came about, grants them nothing:
 * operating the platform never means reading a School's records.
 *
 * All access flows from memberships held at this moment. A Person whose every
 * membership has ended, or not yet begun, is refused here, before any handler
 * runs: departure leaves no access to the School at all, not even to their own
 * Person.
 */
export async function resolveActor(
  database: Queryable,
  { account, failure }: Authentication,
  schoolId: string,
): Promise<Actor> {
  if (account === null) {
    throw new Refused(failure);
  }
  const platformAdministrator = await platformAdministratorFor(database, account.id);
  if (platformAdministrator !== null) {
    throw new Refused("platform-administrator", undefined, { platformAdministrator });
  }
  const person = await personFor(database, { userAccountId: account.id, schoolId });
  if (person === null) {
    throw new Refused("no-person-in-school");
  }
  const roles = await activeRoles(database, person);
  if (roles.size === 0) {
    throw new Refused("no-active-membership", undefined, { person });
  }
  // A link reaches its Student only through a Guardian membership in force, so
  // a Guardian whose membership has ended keeps nothing through their links,
  // whatever else they still hold.
  const linkedStudents = roles.has("guardian") ? await linkedStudentIds(database, person) : new Set<string>();
  const enrolled = roles.has("student") && (await hasOpenEnrollment(database, person));
  const actor: Actor = Object.freeze({ person, schoolId: person.schoolId });
  standingOf.set(actor, { roles, linkedStudentIds: linkedStudents, enrolled });
  return actor;
}

/** A caller resolved to the Platform Administrator they are, acting on the platform. */
export interface PlatformActor {
  readonly platformAdministrator: PlatformAdministrator;
}

/**
 * Resolves a caller to a PlatformActor, or refuses. Platform routes answer to
 * nothing else: no School role, however broad, reaches them.
 */
export async function resolvePlatformActor(
  database: Queryable,
  { account, failure }: Authentication,
): Promise<PlatformActor> {
  if (account === null) {
    throw new Refused(failure);
  }
  const platformAdministrator = await platformAdministratorFor(database, account.id);
  if (platformAdministrator === null) {
    throw new Refused("not-platform-administrator");
  }
  return Object.freeze({ platformAdministrator });
}

/**
 * Whether this account's Person may be given a School membership. A Platform
 * Administrator holds none, and cannot be given one by anyone: their account
 * would be refused in the School whatever it held (see resolveActor), so the
 * membership could only leave a School relying on someone who cannot act.
 */
export async function mayHoldSchoolMembership(
  database: Queryable,
  account: UserAccount,
): Promise<boolean> {
  return (await platformAdministratorFor(database, account.id)) === null;
}

/**
 * The Schools this account can act in: those where its Person holds a
 * membership now. A Platform Administrator can act in none.
 */
export async function reachableSchools(
  database: Queryable,
  account: UserAccount,
): Promise<School[]> {
  if (!(await mayHoldSchoolMembership(database, account))) {
    return [];
  }
  const schools = await schoolsReachedBy(database, account.id);
  const active = await schoolIdsWithActiveMembership(database, account.id);
  return schools.filter((school) => active.has(school.id));
}

function holds(actor: Actor, role: Role): boolean {
  return standingOf.get(actor)?.roles.has(role) ?? false;
}

function isLinkedTo(actor: Actor, student: Person): boolean {
  return standingOf.get(actor)?.linkedStudentIds.has(student.id) ?? false;
}

function isEnrolled(actor: Actor): boolean {
  return standingOf.get(actor)?.enrolled ?? false;
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

/**
 * The one decision on reading a record belonging to a Person: null when
 * permitted, otherwise why not.
 *
 * A Guardian reaches each Student they are linked to, and nothing about the
 * School's structure widens that. The link's Access profile is not consulted
 * here: the slices whose records it gates, Attendance and Term results, enforce
 * it.
 *
 * A Person reaches their own published records whatever their Enrollment, and
 * their own unpublished ones only while an Enrollment is open. The asymmetry
 * with a Guardian, who loses a departed Student entirely, is deliberate: a
 * departed Student still needs their own transcript, whereas a Guardian's
 * standing derives from an active relationship to the School. Whether a
 * Student may read a given unpublished record at all, as they may not a draft
 * Term result, is for the slice owning that record to decide first.
 */
function decideReadRecordOf(
  actor: Actor,
  subject: Person | null,
  { published }: { published: boolean },
): RefusalReason | null {
  const unreachable = outOfReach(actor, subject);
  if (unreachable !== null) {
    return unreachable;
  }
  if (holds(actor, "school_administrator") || isLinkedTo(actor, subject!)) {
    return null;
  }
  if (subject!.id === actor.person.id && (published || isEnrolled(actor))) {
    return null;
  }
  return "forbidden";
}

/**
 * Returns the Person a record belongs to if the actor may read that record, and
 * refuses otherwise, naming the record as the caller did. A Student's records
 * still to be built, Attendance and Term results, are read through this.
 */
export function authorizeReadRecordOf(
  actor: Actor,
  subject: Person | null,
  record: { target: RefusedTarget; published: boolean },
): Person {
  const reason = decideReadRecordOf(actor, subject, record);
  if (reason !== null) {
    throw new Refused(reason, record.target);
  }
  return subject!;
}

/**
 * A Person's own record, who they are, is never withheld from them, just as a
 * published record is not: departure does not hide a Student from themself.
 */
function decideReadPerson(actor: Actor, target: Person | null): RefusalReason | null {
  return decideReadRecordOf(actor, target, { published: true });
}

/**
 * Returns the target if the actor may read it, and refuses otherwise. The
 * requested identifier is what the refusal names, since an absent target has
 * no identifier of its own.
 */
export function authorizeReadPerson(actor: Actor, personId: string, target: Person | null): Person {
  return authorizeReadRecordOf(actor, target, {
    target: { type: "person", id: personId },
    published: true,
  });
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
export function readablePersons<P extends Person>(actor: Actor, persons: readonly P[]): P[] {
  return persons.filter((person) => decideReadPerson(actor, person) === null);
}

/**
 * Whether the actor may see which Persons are claimed, that is, attached to a
 * User account. Only a School Administrator may: it tells them who still needs
 * an Invitation. To anyone else, whether a Person can sign in is an
 * administrative matter, so it is left out of what they are served altogether.
 */
export function mayReadClaimedState(actor: Actor): boolean {
  return holds(actor, "school_administrator");
}

/**
 * Returns the School the actor may create a Person in, and refuses otherwise.
 * Only a School Administrator shapes who belongs to a School, and only in the
 * School they are acting in.
 *
 * Asked before a request's body is read, so a caller who may not create
 * Persons is refused whatever they sent, and never learns that a body was
 * wrong.
 */
export function authorizeCreatePerson(actor: Actor): string {
  if (!holds(actor, "school_administrator")) {
    throw new Refused("forbidden", { type: "school", id: actor.schoolId });
  }
  return actor.schoolId;
}

/**
 * Returns the School whose Invitations the actor may issue, list, and revoke,
 * and refuses otherwise. Only a School Administrator may, in the School they are
 * acting in: any of them, whoever issued the Invitation. Asked before a
 * request's body is read, as for memberships.
 */
export function authorizeManageInvitations(actor: Actor): string {
  return authorizeManageRelationships(actor);
}

/**
 * Returns the Person the actor may invite, and refuses otherwise. An Invitation
 * attaches a Person to whoever redeems it, so a Person already attached to a
 * User account is never invited: that would hand their access to someone else.
 */
export function authorizeInvite(actor: Actor, personId: string, target: ListedPerson | null): ListedPerson {
  const reason = decideManageRelationships(actor, target) ?? (target!.claimed ? "claimed" : null);
  if (reason !== null) {
    throw new Refused(reason, { type: "person", id: personId });
  }
  return target!;
}

/**
 * Returns the Invitation the actor may revoke, and refuses otherwise. Only a
 * pending one can be: one already revoked, redeemed, or expired is refused like
 * one that does not exist, with why written to the Audit record.
 */
export function authorizeRevokeInvitation(
  actor: Actor,
  invitationId: string,
  target: Invitation | null,
  now: Date,
): Invitation {
  const reason = decideManageRelationships(actor, target) ?? notPending(invitationState(target!, now));
  if (reason !== null) {
    throw new Refused(reason, { type: "invitation", id: invitationId });
  }
  return target!;
}

function notPending(state: InvitationState): RefusalReason | null {
  return state === "pending" ? null : state;
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
  return authorizeManageRelationships(actor);
}

/**
 * Returns the School whose Guardian links the actor may list and create in, and
 * refuses otherwise. Guardian links are managed exactly as memberships are: by
 * a School Administrator, in the School they are acting in, asked before the
 * body is read.
 */
export function authorizeManageGuardianLinks(actor: Actor): string {
  return authorizeManageRelationships(actor);
}

/**
 * Returns the School whose Enrollments the actor may list and record in, and
 * refuses otherwise. Enrollments are managed exactly as memberships are: by a
 * School Administrator, in the School they are acting in, asked before the
 * body is read.
 */
export function authorizeManageEnrollments(actor: Actor): string {
  return authorizeManageRelationships(actor);
}

function authorizeManageRelationships(actor: Actor): string {
  const reason = decideManageRelationships(actor, { schoolId: actor.schoolId });
  if (reason !== null) {
    throw new Refused(reason, { type: "school", id: actor.schoolId });
  }
  return actor.schoolId;
}

/**
 * The one decision for a School's relationships, memberships, Guardian links,
 * and Enrollments alike: null when permitted, otherwise why not.
 */
function decideManageRelationships(
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
  const reason = decideManageRelationships(actor, target);
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
  const reason = decideManageRelationships(actor, target);
  if (reason !== null) {
    throw new Refused(reason, { type: "membership", id: membershipId });
  }
  return target!;
}

/**
 * Returns the Guardian and Student the actor may link, and refuses otherwise.
 * Each side is decided on its own and refused under the identifier it was
 * named by, so naming a Person who is absent or in another School is refused
 * whichever side names them.
 */
export function authorizeLinkGuardian(
  actor: Actor,
  guardian: { personId: string; person: Person | null },
  student: { personId: string; person: Person | null },
): { guardian: Person; student: Person } {
  for (const { personId, person } of [guardian, student]) {
    const reason = decideManageRelationships(actor, person);
    if (reason !== null) {
      throw new Refused(reason, { type: "person", id: personId });
    }
  }
  return { guardian: guardian.person!, student: student.person! };
}

/** Returns the Guardian link the actor may change or revoke, and refuses otherwise. */
export function authorizeManageGuardianLink(
  actor: Actor,
  guardianLinkId: string,
  target: GuardianLink | null,
): GuardianLink {
  const reason = decideManageRelationships(actor, target);
  if (reason !== null) {
    throw new Refused(reason, { type: "guardian_link", id: guardianLinkId });
  }
  return target!;
}

/** Returns the Student the actor may record an Enrollment for, and refuses otherwise. */
export function authorizeEnroll(actor: Actor, personId: string, target: Person | null): Person {
  const reason = decideManageRelationships(actor, target);
  if (reason !== null) {
    throw new Refused(reason, { type: "person", id: personId });
  }
  return target!;
}

/** Returns the Enrollment the actor may end, and refuses otherwise. */
export function authorizeManageEnrollment(
  actor: Actor,
  enrollmentId: string,
  target: Enrollment | null,
): Enrollment {
  const reason = decideManageRelationships(actor, target);
  if (reason !== null) {
    throw new Refused(reason, { type: "enrollment", id: enrollmentId });
  }
  return target!;
}
