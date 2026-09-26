import type { Authentication, AuthenticationFailure, UserAccount } from "../authentication/index.ts";
import type { Queryable } from "../db/transaction.ts";
import {
  findPersons,
  personFor,
  platformAdministratorFor,
  schoolsReachedBy,
  trialExpiryOf,
  trialRoleOf,
  type ListedPerson,
  type Person,
  type PlatformAdministrator,
  type School,
} from "../identity/index.ts";
import { invitationState, type Invitation, type InvitationState } from "../identity/invitations.ts";
import { currentEnrollmentOf, hasOpenEnrollment, type Enrollment } from "./enrollments.ts";
import { guardianLinksHeldBy, linkedStudentIds, type AccessProfile, type GuardianLink } from "./guardian-links.ts";
import {
  activeRoles,
  ROLES,
  schoolIdsWithActiveMembership,
  type Membership,
  type Role,
} from "./memberships.ts";
import { schoolDateAt, type SchoolDate } from "../calendar/index.ts";
import { transactionTime } from "../db/transaction.ts";
import { findClassOffering, lockClassOffering, type DescribedClassOffering } from "../academic-structure/courses.ts";
import type { Participation, Participations } from "./participation.ts";
import { teachingAssignments, type TeachingAssignment } from "./teaching-assignments.ts";
import { rosterMemberships, type RosterMembership } from "./roster-memberships.ts";

/**
 * The Access module is the sole authority on whether an actor may do something
 * to a target. It owns School memberships, Guardian links, Enrollments,
 * Teaching assignments and Roster memberships, and nothing outside it reads
 * one: an Actor's roles, links, and Enrollment are kept
 * here rather than on the Actor, so a handler holding an Actor can ask this
 * module for a decision but cannot make the decision itself.
 */
export { grantMembership, ROLES, type Membership, type Role } from "./memberships.ts";
export { recordEnrollment, type Enrollment } from "./enrollments.ts";
export { linkGuardian, type AccessProfile, type GuardianLink } from "./guardian-links.ts";
export { assignTeaching, type TeachingAssignment } from "./teaching-assignments.ts";
export { rosterStudent, type RosterMembership } from "./roster-memberships.ts";

/**
 * Why a request was refused. It is written to the Audit record, where a School
 * Administrator can investigate it, and never reaches the caller: see `refuse`
 * in http/refusal.ts.
 */
export type RefusalReason =
  /** The request belonged to no User account at all: see AuthenticationFailure. */
  | AuthenticationFailure
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
  /**
   * The Class Offerings the Actor was ever assigned to teach. Unlike a link or
   * an Enrollment, these outlast the Faculty membership: one who taught an
   * offering keeps reading its history while they hold any role in the School
   * (CONTEXT.md: Teaching assignment).
   */
  taughtClassOfferingIds: ReadonlySet<string>;
  /**
   * The Class Offerings the Actor, as a Student, was ever rostered in. Like
   * those taught, these outlast the membership's end, and the Enrollment's: a
   * departed Student keeps reading the Class Offerings they took part in (CONTEXT.md:
   * Enrollment).
   */
  rosteredClassOfferingIds: ReadonlySet<string>;
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
  const taught = await teachingAssignments.classOfferingIdsOf(database, person);
  const rostered = roles.has("student") ? await rosterMemberships.classOfferingIdsOf(database, person) : new Set<string>();
  const actor: Actor = Object.freeze({ person, schoolId: person.schoolId });
  standingOf.set(actor, {
    roles,
    linkedStudentIds: linkedStudents,
    enrolled,
    taughtClassOfferingIds: taught,
    rosteredClassOfferingIds: rostered,
  });
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

/**
 * One School an account reaches, the Person it resolves to there, and the
 * roles that Person holds at this moment.
 */
export interface ReachedSchool {
  schoolId: string;
  /** The School's name; the Person's is `displayName`. */
  name: string;
  personId: string;
  displayName: string;
  roles: Role[];
  /**
   * When the School expires, only when it is a Trial School, so a client can
   * say how long it has left and know when it has ended (ADR-0012).
   */
  trialExpiresAt?: string;
  /**
   * How many Class Offerings the Person was ever assigned to teach, ended
   * assignments included. What they taught outlasts their Faculty membership
   * (CONTEXT.md: Teaching assignment), so this is the one fact beyond the roles
   * a client needs to lead a Person to it once that role has ended.
   */
  classOfferingsTaught: number;
  /**
   * The role this account acts as, only when it is one of a Trial School's
   * role accounts: its visitor may change to any other (ADR-0012).
   */
  viewingAs?: Role;
}

/**
 * What the account holding a Session can be told about itself: every School it
 * reaches, named with the Person and roles that are its own facts.
 *
 * Facts, never a decision (ADR-0007). Roles are here because they are the
 * actor's own; whether a role may do a given thing stays in this module's
 * decisions, where it is enforced. Nothing about any other Person appears, and
 * each School names only what belongs to it (ADR-0001).
 */
export async function actorInEachSchool(
  database: Queryable,
  account: UserAccount,
): Promise<ReachedSchool[]> {
  const reached: ReachedSchool[] = [];
  for (const school of await reachableSchools(database, account)) {
    const person = await personFor(database, { userAccountId: account.id, schoolId: school.id });
    // A School is reachable only through the Person the account resolves to in
    // it, so this cannot be null; skipped rather than asserted, because an
    // account losing its Person between the two queries is not worth failing on.
    if (person === null) {
      continue;
    }
    const held = await activeRoles(database, person);
    const trialExpiresAt = await trialExpiryOf(database, school.id);
    const viewingAs = trialExpiresAt === null ? null : await trialRoleOf(database, account.id);
    reached.push({
      schoolId: school.id,
      name: school.name,
      personId: person.id,
      displayName: person.displayName,
      // In the order ROLES declares, so the response does not vary with what
      // the database happened to return first.
      roles: ROLES.filter((role) => held.has(role)),
      classOfferingsTaught: (await teachingAssignments.classOfferingIdsOf(database, person)).size,
      ...(trialExpiresAt === null ? {} : { trialExpiresAt: trialExpiresAt.toISOString() }),
      ...(viewingAs === null ? {} : { viewingAs }),
    });
  }
  return reached;
}

/**
 * One Student an actor reaches as their Guardian, and what that link's Access
 * profile permits. Read-only: changing a profile is a School Administrator's,
 * through the Guardian link routes.
 */
export interface LinkedStudent {
  student: { id: string; displayName: string };
  accessProfile: AccessProfile;
}

/**
 * What an actor holds in the School they are acting in, beyond what the
 * session already says: the Enrollment they hold as a Student, and the
 * Students they reach as a Guardian.
 *
 * Who the actor is here and which roles they hold are the session's to name
 * (see actorInEachSchool), and are not restated: one fact with two sources is
 * a fact that can disagree with itself.
 */
export interface OwnAccount {
  /** The Enrollment as it stands, for an actor holding a Student membership; null otherwise. */
  enrollment: { startedAt: string; endedAt: string | null } | null;
  /** Empty for an actor who is not a Guardian, and for one linked to no Student. */
  linkedStudents: LinkedStudent[];
}

/**
 * What the actor can be told about themselves within one School.
 *
 * Every actor reaches this, and only about themselves: a Person's own record
 * is never withheld from them, and nothing here reads beyond what their own
 * memberships, Enrollment and links already say. The Students a Guardian is
 * named are exactly the ones their links reach, which is what
 * `decideReadRecordOf` already permits them to read.
 *
 * Facts, never a decision (ADR-0007). An Access profile appears because it is
 * the actor's own standing, not so a page can act on it: the slices whose
 * records it gates, Attendance and Term results, enforce it themselves.
 */
export async function ownAccount(database: Queryable, actor: Actor): Promise<OwnAccount> {
  const enrollment = holds(actor, "student")
    ? await currentEnrollmentOf(database, actor.person)
    : null;
  const links = holds(actor, "guardian") ? await guardianLinksHeldBy(database, actor.person) : [];
  // Read through the Identity module rather than joined onto the links, so a
  // Person is still only ever read where Persons are owned.
  const students = await findPersons(
    database,
    links.map((link) => link.studentPersonId),
  );
  return {
    enrollment:
      enrollment === null
        ? null
        : {
            startedAt: enrollment.startedAt.toISOString(),
            endedAt: enrollment.endedAt?.toISOString() ?? null,
          },
    linkedStudents: links.flatMap((link) => {
      const student = students.get(link.studentPersonId);
      // A link's Student cannot be absent; skipped rather than asserted, for
      // the same reason actorInEachSchool skips a School without its Person.
      return student === undefined
        ? []
        : [{ student: { id: student.id, displayName: student.displayName }, accessProfile: link.accessProfile }];
    }),
  };
}

/** A Teaching assignment or Roster membership as served: whose it is, by display name alone, and its bounds. */
export interface ServedParticipation {
  id: string;
  person: { id: string; displayName: string };
  firstDate: string;
  lastDate: string | null;
}

/** These participations as served, in no particular order. */
async function serveParticipations(
  database: Queryable,
  participations: readonly Participation[],
): Promise<ServedParticipation[]> {
  // Read through the Identity module, as ownAccount reads linked Students.
  const persons = await findPersons(
    database,
    participations.map((participation) => participation.personId),
  );
  return participations.map(({ id, personId, firstDate, lastDate }) => ({
    id,
    person: { id: personId, displayName: persons.get(personId)?.displayName ?? "" },
    firstDate,
    lastDate,
  }));
}

/** Each of these Class Offerings' participations of one kind, as `serve` serves and orders them, by offering. */
async function servedOn(
  database: Queryable,
  participations: Participations,
  classOfferingIds: readonly string[],
  serve: (database: Queryable, held: readonly Participation[]) => Promise<ServedParticipation[]>,
): Promise<Map<string, ServedParticipation[]>> {
  const held = await participations.on(database, classOfferingIds);
  const offeringOf = new Map(held.map((participation) => [participation.id, participation.classOfferingId]));
  const byOffering = new Map(classOfferingIds.map((id) => [id, [] as ServedParticipation[]]));
  for (const served of await serve(database, held)) {
    byOffering.get(offeringOf.get(served.id)!)?.push(served);
  }
  return byOffering;
}

/**
 * These Teaching assignments as served, in the order a Class Offering lists
 * them: by when each begins, then by whose it is. Only a caller already
 * permitted to read them asks.
 */
export async function serveTeachingAssignments(
  database: Queryable,
  assignments: readonly TeachingAssignment[],
): Promise<ServedParticipation[]> {
  return (await serveParticipations(database, assignments)).sort(
    (a, b) =>
      a.firstDate.localeCompare(b.firstDate) ||
      a.person.displayName.localeCompare(b.person.displayName) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Each of these Class Offerings' Teaching assignments as served, by offering.
 * Only for offerings the caller has already been permitted to read.
 */
export async function teachingAssignmentsServedOn(
  database: Queryable,
  classOfferingIds: readonly string[],
): Promise<Map<string, ServedParticipation[]>> {
  return servedOn(database, teachingAssignments, classOfferingIds, serveTeachingAssignments);
}

/** A Class Offering at a glance: who teaches it, by display name alone, and how many Students are on its roster. */
export interface OfferingAtAGlance {
  faculty: { id: string; displayName: string }[];
  rosterSize: number;
}

/**
 * Each of these Class Offerings at a glance, on one School date of its Term:
 * today while the Term runs, its first date before it begins, and its last
 * once it has ended. So an ended Term shows who finished it, and one to come
 * who starts it. Only for offerings the caller has already been permitted to
 * list.
 */
export async function offeringsAtAGlance(
  database: Queryable,
  actor: Actor,
  offerings: readonly { id: string; term: { firstDate: string; lastDate: string } }[],
): Promise<Map<string, OfferingAtAGlance>> {
  const ids = offerings.map((offering) => offering.id);
  const today = (await schoolDateAt(database, { schoolId: actor.schoolId, at: await transactionTime(database) }))!;
  // `YYYY-MM-DD` sorts as the dates do.
  const dayOf = new Map(
    offerings.map(({ id, term }) => [
      id,
      today < term.firstDate ? term.firstDate : today > term.lastDate ? term.lastDate : today,
    ]),
  );
  const runsOnItsDay = ({ classOfferingId, firstDate, lastDate }: Participation) => {
    const day = dayOf.get(classOfferingId)!;
    return firstDate <= day && (lastDate === null || day <= lastDate);
  };
  // No two of one Person's in one offering overlap, so each counts once.
  const teaching = (await teachingAssignments.on(database, ids)).filter(runsOnItsDay);
  const rostered = (await rosterMemberships.on(database, ids)).filter(runsOnItsDay);
  const persons = await findPersons(
    database,
    teaching.map((assignment) => assignment.personId),
  );
  const glances = new Map(ids.map((id) => [id, { faculty: [], rosterSize: 0 } as OfferingAtAGlance]));
  for (const { classOfferingId, personId } of teaching) {
    glances.get(classOfferingId)!.faculty.push({ id: personId, displayName: persons.get(personId)?.displayName ?? "" });
  }
  for (const { classOfferingId } of rostered) {
    glances.get(classOfferingId)!.rosterSize += 1;
  }
  for (const { faculty } of glances.values()) {
    faculty.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));
  }
  return glances;
}

/**
 * The Class Offerings the actor was ever assigned to teach: those where an
 * assignment of theirs still runs today or later, and those where every one
 * has ended. Only for an actor already permitted to list them.
 */
export async function ownClassOfferings(
  database: Queryable,
  actor: Actor,
): Promise<{ current: Set<string>; past: Set<string> }> {
  const today = (await schoolDateAt(database, { schoolId: actor.schoolId, at: await transactionTime(database) }))!;
  const taught = await teachingAssignments.classOfferingsOf(database, actor.person, today);
  const current = new Set<string>();
  const past = new Set<string>();
  for (const [id, { current: isCurrent }] of taught) {
    (isCurrent ? current : past).add(id);
  }
  return { current, past };
}

/**
 * These Roster memberships as served, in the order a roster lists them: by
 * whose they are, then by when each begins. Only a caller already permitted to
 * read them asks.
 */
export async function serveRosterMemberships(
  database: Queryable,
  memberships: readonly RosterMembership[],
): Promise<ServedParticipation[]> {
  return (await serveParticipations(database, memberships)).sort(
    (a, b) =>
      a.person.displayName.localeCompare(b.person.displayName) ||
      a.firstDate.localeCompare(b.firstDate) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Each of these Class Offerings' rosters as served, by offering. Only for
 * offerings whose roster the caller has already been permitted to read: see
 * mayReadRosterOf.
 */
export async function rostersServedOn(
  database: Queryable,
  classOfferingIds: readonly string[],
): Promise<Map<string, ServedParticipation[]>> {
  return servedOn(database, rosterMemberships, classOfferingIds, serveRosterMemberships);
}

/** One of the actor's own Roster memberships, as they are served it: its bounds, and nothing of anyone else's. */
export interface OwnRosterMembership {
  id: string;
  firstDate: string;
  lastDate: string | null;
}

/**
 * The actor's own Roster memberships, ended ones included, by the Class
 * Offering each is in, with the School date today is. Only for an actor
 * already permitted to list them.
 */
export async function ownRosterMemberships(
  database: Queryable,
  actor: Actor,
): Promise<{ today: string; byOffering: Map<string, OwnRosterMembership[]> }> {
  const today = (await schoolDateAt(database, { schoolId: actor.schoolId, at: await transactionTime(database) }))!;
  const byOffering = new Map<string, OwnRosterMembership[]>();
  for (const { id, classOfferingId, firstDate, lastDate } of await rosterMemberships.of(database, actor.person)) {
    byOffering.set(classOfferingId, [...(byOffering.get(classOfferingId) ?? []), { id, firstDate, lastDate }]);
  }
  return { today, byOffering };
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

/**
 * Returns the School whose settings the actor may read and change, and refuses
 * otherwise. Only a School Administrator configures a School, and only the one
 * they are acting in: its timezone is theirs to see and set, and no one else's
 * business. Asked before a request's body is read, as for memberships.
 */
export function authorizeManageSchoolSettings(actor: Actor): string {
  return authorizeManageRelationships(actor);
}

/**
 * Returns the School whose calendar the actor may ask about, and refuses
 * otherwise. For now only a School Administrator may: which School date an
 * instant falls on tells the asker the School's timezone, which is one of its
 * settings. The slice that first needs another role to ask widens this.
 */
export function authorizeReadSchoolCalendar(actor: Actor): string {
  return authorizeManageRelationships(actor);
}

/**
 * Returns the School whose academic structure the actor may read and change,
 * and refuses otherwise. For now that is its Academic Years, their Terms and
 * Instructional days, its Courses and its Class Offerings, and only a School
 * Administrator shapes them, in the School they are acting in. Asked before a
 * request's body is read, as for memberships.
 */
export function authorizeManageAcademicStructure(actor: Actor): string {
  return authorizeManageRelationships(actor);
}

/** Returns the Academic Year the actor may change or delete, and refuses otherwise. */
export function authorizeManageAcademicYear<Y extends { schoolId: string }>(
  actor: Actor,
  academicYearId: string,
  target: Y | null,
): Y {
  const reason = decideManageRelationships(actor, target);
  if (reason !== null) {
    throw new Refused(reason, { type: "academic_year", id: academicYearId });
  }
  return target!;
}

/**
 * Returns the exception to an Academic Year's weekday pattern the actor may
 * remove, and refuses otherwise. Asked once the actor may change the year, so
 * one the year does not have is refused as absent, whatever else holds it.
 */
export function authorizeManageInstructionalDayException<E extends { schoolId: string }>(
  actor: Actor,
  exceptionId: string,
  target: E | null,
): E {
  const reason = decideManageRelationships(actor, target);
  if (reason !== null) {
    throw new Refused(reason, { type: "instructional_day_exception", id: exceptionId });
  }
  return target!;
}

/** Returns the Course the actor may change, delete, or offer, and refuses otherwise. */
export function authorizeManageCourse<C extends { schoolId: string }>(
  actor: Actor,
  courseId: string,
  target: C | null,
): C {
  const reason = decideManageRelationships(actor, target);
  if (reason !== null) {
    throw new Refused(reason, { type: "course", id: courseId });
  }
  return target!;
}

/** Returns the Term the actor may offer a Course in, and refuses otherwise. */
export function authorizeManageTerm<T extends { schoolId: string }>(actor: Actor, termId: string, target: T | null): T {
  const reason = decideManageRelationships(actor, target);
  if (reason !== null) {
    throw new Refused(reason, { type: "term", id: termId });
  }
  return target!;
}

/**
 * Returns the Class Offering the actor may relabel, delete, or assign Faculty
 * to, and refuses otherwise. Only a School Administrator changes one.
 */
export function authorizeManageClassOffering<O extends { schoolId: string }>(
  actor: Actor,
  classOfferingId: string,
  target: O | null,
): O {
  const reason = decideManageRelationships(actor, target);
  if (reason !== null) {
    throw new Refused(reason, { type: "class_offering", id: classOfferingId });
  }
  return target!;
}

/**
 * Returns the Class Offering the actor may read, with its Teaching
 * assignments, and refuses otherwise. A School Administrator reads every one
 * in their School. Anyone ever assigned to teach one reads it, ended
 * assignments included, even once their Faculty membership has ended
 * (CONTEXT.md: Teaching assignment). A Student reads each they were ever
 * rostered in, even once their Enrollment has ended (CONTEXT.md: Enrollment).
 * No one else does.
 * Of the Persons it names they are told display names alone, so this grants
 * nothing about those Persons beyond it. Whether its roster is among them is
 * mayReadRosterOf's to say.
 */
export function authorizeReadClassOffering<O extends { id: string; schoolId: string }>(
  actor: Actor,
  classOfferingId: string,
  target: O | null,
): O {
  const reason =
    outOfReach(actor, target) ??
    (holds(actor, "school_administrator") || hasTaught(actor, target!) || wasRostered(actor, target!)
      ? null
      : "forbidden");
  if (reason !== null) {
    throw new Refused(reason, { type: "class_offering", id: classOfferingId });
  }
  return target!;
}

/**
 * Whether the actor, already permitted to read this Class Offering, may read
 * its roster too: a School Administrator, and anyone ever assigned to teach
 * it. A Student reads their own Class Offerings but never their classmates, so the
 * roster is left out of what they are served altogether.
 */
export function mayReadRosterOf(actor: Actor, offering: { id: string; schoolId: string }): boolean {
  return (
    offering.schoolId === actor.schoolId && (holds(actor, "school_administrator") || hasTaught(actor, offering))
  );
}

/**
 * Returns the School whose Class Offerings the actor may list as the ones they
 * are and were rostered in, and refuses otherwise. Only a Student has any, and
 * keeps them once their Enrollment has ended.
 */
export function authorizeReadOwnRosterMemberships(actor: Actor): string {
  if (!holds(actor, "student")) {
    throw new Refused("forbidden", { type: "school", id: actor.schoolId });
  }
  return actor.schoolId;
}

function wasRostered(actor: Actor, offering: { id: string }): boolean {
  return standingOf.get(actor)?.rosteredClassOfferingIds.has(offering.id) ?? false;
}

/**
 * Returns the Person the actor may roster, and refuses otherwise. Whether that
 * Person holds an open Enrollment is a matter of the request, checked once
 * this has permitted it.
 */
export function authorizeRoster(actor: Actor, personId: string, target: Person | null): Person {
  const reason = decideManageRelationships(actor, target);
  if (reason !== null) {
    throw new Refused(reason, { type: "person", id: personId });
  }
  return target!;
}

/**
 * Returns the School whose Roster memberships the actor may make, and refuses
 * otherwise. They are managed as memberships are: by a School Administrator,
 * in the School they are acting in, asked before the body is read.
 */
export function authorizeManageRosterMemberships(actor: Actor): string {
  return authorizeManageRelationships(actor);
}

/**
 * Returns the School whose Class Offerings the actor may list as the ones they
 * teach and taught, and refuses otherwise. A Faculty member lists theirs, none
 * though they may be. So does anyone ever assigned to teach in the School, once
 * their Faculty membership has ended too: they keep reading what they taught
 * (CONTEXT.md: Teaching assignment), so they keep the list of it. A Student's
 * own are authorizeReadOwnRosterMemberships's.
 */
export function authorizeReadOwnClassOfferings(actor: Actor): string {
  const taught = standingOf.get(actor)?.taughtClassOfferingIds.size ?? 0;
  if (!holds(actor, "faculty") && taught === 0) {
    throw new Refused("forbidden", { type: "school", id: actor.schoolId });
  }
  return actor.schoolId;
}

function hasTaught(actor: Actor, offering: { id: string }): boolean {
  return standingOf.get(actor)?.taughtClassOfferingIds.has(offering.id) ?? false;
}

/**
 * Returns the Person the actor may assign to teach, and refuses otherwise.
 * Whether that Person holds a Faculty membership is a matter of the request,
 * checked once this has permitted it.
 */
export function authorizeAssignTeaching(actor: Actor, personId: string, target: Person | null): Person {
  const reason = decideManageRelationships(actor, target);
  if (reason !== null) {
    throw new Refused(reason, { type: "person", id: personId });
  }
  return target!;
}

/**
 * Returns the School whose Teaching assignments the actor may make, and
 * refuses otherwise. They are managed as memberships are: by a School
 * Administrator, in the School they are acting in, asked before the body is
 * read.
 */
export function authorizeManageTeachingAssignments(actor: Actor): string {
  return authorizeManageRelationships(actor);
}

/** Returns the Teaching assignment or Roster membership the actor may change or end, and refuses otherwise. */
function authorizeManageParticipation<P extends Participation>(
  actor: Actor,
  participations: Participations,
  id: string,
  target: P | null,
): P {
  const reason = decideManageRelationships(actor, target);
  if (reason !== null) {
    throw new Refused(reason, { type: participations.kind, id });
  }
  return target!;
}

/*
 * Each record the actor may act on is found, decided, and only then locked:
 * see lockMembership. One deleted between the two is decided again as the
 * absent record it now is, so the caller is refused as for any other.
 */

/** The Class Offering the actor may change or add participation to, locked for the rest of the transaction. */
export async function lockPermittedOffering(
  transaction: Queryable,
  actor: Actor,
  classOfferingId: string,
): Promise<DescribedClassOffering> {
  const permitted = authorizeManageClassOffering(
    actor,
    classOfferingId,
    await findClassOffering(transaction, classOfferingId),
  );
  return (
    (await lockClassOffering(transaction, permitted)) ??
    authorizeManageClassOffering<DescribedClassOffering>(actor, classOfferingId, null)
  );
}

/**
 * The Teaching assignment or Roster membership the actor may change or end,
 * locked for the rest of the transaction, with the last School date of its
 * Term.
 */
export async function lockPermittedParticipation(
  transaction: Queryable,
  actor: Actor,
  participations: Participations,
  id: string,
): Promise<Participation & { termLastDate: SchoolDate }> {
  const permitted = authorizeManageParticipation(actor, participations, id, await participations.find(transaction, id));
  return (
    (await participations.lock(transaction, permitted)) ??
    authorizeManageParticipation<Participation & { termLastDate: SchoolDate }>(actor, participations, id, null)
  );
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
