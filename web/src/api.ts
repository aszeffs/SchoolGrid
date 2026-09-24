import type { Role } from "../../src/access/roles.ts";
import type { ConflictDetail } from "../../src/http/conflict.ts";

/**
 * The API, reached on the page's own origin.
 *
 * The session is the cookie the browser holds, which page script cannot read
 * (ADR-0004). Nothing here asks for, reads or stores a token: the browser sends
 * the cookie with every same-origin request by itself, and an `Origin` with
 * every change, which is what the server checks the cookie against.
 */

/**
 * What a request answered. A failure carries a conflict only when the server
 * permitted the change and the School's records could not take it; every
 * other failure carries nothing.
 */
export type ApiResult<T> = { ok: true; body: T } | { ok: false; conflict?: ConflictDetail };

export type { ConflictDetail };

/** A response that was sent and read, or null for a network failure. */
interface Sent {
  status: number;
  body: unknown;
}

/** The one place a request is actually sent, so every call shares its parsing and its failure handling. */
async function send(method: string, path: string, body?: unknown): Promise<Sent | null> {
  try {
    const response = await fetch(`/api${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
  } catch {
    return null;
  }
}

/**
 * Sends a request and says only whether it was answered. A refusal, a throttled
 * request, a server error and a network failure are all `ok: false`: the app
 * has one state for all of them, and never explains a refusal the API
 * deliberately did not explain (ADR-0002).
 *
 * A conflict is not a refusal. The server answers one only once it has
 * permitted the caller, to say which rule of the School's records a change
 * would break, and a form says so in its own words.
 */
async function request<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  const sent = await send(method, path, body);
  if (sent !== null && sent.status === 409 && isConflict(sent.body)) {
    const { status: _status, ...conflict } = sent.body;
    return { ok: false, conflict };
  }
  if (sent === null || sent.status < 200 || sent.status >= 300) {
    return { ok: false };
  }
  return { ok: true, body: sent.body as T };
}

function isConflict(body: unknown): body is { status: "conflict" } & ConflictDetail {
  return typeof body === "object" && body !== null && (body as { status?: unknown }).status === "conflict";
}

/** What an answer carries when it is answered. */
type BodyOf<A> = A extends { ok: true; body: infer B } ? B : never;

/**
 * Several requests, sent together and answered as one: answered only when
 * every one of them was, so a screen that reads more than one record has the
 * same one way of failing as a screen that reads one.
 */
export async function readAll<const R extends readonly Promise<ApiResult<unknown>>[]>(
  reads: R,
): Promise<ApiResult<{ -readonly [K in keyof R]: BodyOf<Awaited<R[K]>> }>> {
  const bodies: unknown[] = [];
  for (const answer of await Promise.all(reads)) {
    if (!answer.ok) {
      return { ok: false };
    }
    bodies.push(answer.body);
  }
  return { ok: true, body: bodies as { -readonly [K in keyof R]: BodyOf<Awaited<R[K]>> } };
}

/** A role a Person holds in their School, imported rather than restated. */
export type { Role };

/**
 * One School the signed-in account reaches: the Person it resolves to there
 * and the roles that Person holds.
 *
 * Facts about the actor, never permissions (ADR-0007). Roles say what to put
 * in the navigation, so a caller is not led into a refusal; they never say
 * whether an action will be allowed. The server alone decides that, and an
 * action it refuses still shows the one "not available" state.
 */
export interface ReachedSchool {
  schoolId: string;
  /** The School's name; the Person's is `displayName`. */
  name: string;
  personId: string;
  displayName: string;
  roles: Role[];
}

/** Whoever holds the session: the account, and each School it reaches. */
export interface Session {
  account: { id: string; username: string };
  /** Empty for an account reaching no School, which is not a refusal. */
  schools: ReachedSchool[];
}

/** What a Guardian link permits, each permission independent of the other. */
export interface AccessProfile {
  attendanceRead: boolean;
  resultsRead: boolean;
}

/** One Student the actor reaches as their Guardian, and what that link permits. */
export interface LinkedStudent {
  student: { id: string; displayName: string };
  accessProfile: AccessProfile;
}

/**
 * What the actor holds in one School beyond what the session already says: the
 * Enrollment they hold as a Student, and the Students they reach as a
 * Guardian.
 *
 * The Person, the School and the roles are the session's (see `ReachedSchool`)
 * and are not restated here: one fact with two sources is a fact that can
 * disagree with itself.
 */
export interface OwnAccount {
  /** Null for a Person holding no Student membership, and for a Student never enrolled. */
  enrollment: { startedAt: string; endedAt: string | null } | null;
  linkedStudents: LinkedStudent[];
}

export interface ListedPerson {
  id: string;
  displayName: string;
  /** Whether a User account is attached. Sent only to a School Administrator. */
  claimed?: boolean;
}

/** A pending Invitation. Its secret is never among what is listed. */
export interface Invitation {
  id: string;
  person: { id: string; displayName: string };
  issuedAt: string;
  expiresAt: string;
}

/** One role held by one Person between its own bounds. A Person holding several holds several of these. */
export interface Membership {
  id: string;
  personId: string;
  role: Role;
  startsAt: string;
  /** Null while it has no end. */
  endsAt: string | null;
}

/** One Student's participation in the School, from when it was recorded until it ended. */
export interface Enrollment {
  id: string;
  studentPersonId: string;
  startedAt: string;
  /** Null while it is open. */
  endedAt: string | null;
  /** Why it ended; null while it is open. */
  endReason: string | null;
}

/** A Guardian's link to one Student, and the Access profile it carries. */
export interface GuardianLink {
  id: string;
  guardianPersonId: string;
  studentPersonId: string;
  accessProfile: AccessProfile;
  createdAt: string;
  /** Null while it is in force. */
  endedAt: string | null;
}

/**
 * One entry in a School's trail. It names who acted and what was acted on by
 * identifier alone; a screen puts names to them from what it already reads.
 */
export interface AuditRecord {
  id: string;
  occurredAt: string;
  /** Null when no Person acted: an unauthenticated caller, a Platform Administrator, or the platform. */
  actorPersonId: string | null;
  actorPlatformAdministratorId: string | null;
  /** What happened, as `<subject>.<verb>`, such as `school.provisioned`. */
  action: string;
  target: { type: string; id: string | null };
  reason: string | null;
}

/** One page of a School's trail, newest first, and the cursor the next page is read from. */
export interface AuditPage {
  auditRecords: AuditRecord[];
  /** Null on the last page. */
  nextCursor: string | null;
}

/** What a School Administrator configures about their School. */
export interface SchoolSettings {
  /** An IANA timezone identifier, such as `America/New_York`: where the School's days begin and end. */
  timezone: string;
  /** Whether the timezone can no longer change, as it cannot once the School has an Academic Year. */
  timezoneFixed: boolean;
}

/** One Term of an Academic Year, bounded by School dates written `YYYY-MM-DD`, both inclusive. */
export interface Term {
  id: string;
  name: string;
  firstDate: string;
  lastDate: string;
}

/** An Academic Year, bounded by School dates, with its Terms in order. None while it is not yet divided. */
export interface AcademicYear {
  id: string;
  name: string;
  firstDate: string;
  lastDate: string;
  terms: Term[];
}

/** A Term as a change states it: one of the year's own by its identifier, or a new one without. */
export interface ProposedTerm {
  id?: string;
  name: string;
  firstDate: string;
  lastDate: string;
}

/** What the running site was built from. Either is absent when the server does not know it. */
export interface BuildInfo {
  commit?: string;
  digest?: string;
}

/** A sign-in the public demo publishes. Every other deployment publishes none. */
export interface DemoAccount {
  role: Role;
  username: string;
  password: string;
}

/** A path within one School. */
const inSchool = (schoolId: string, path: string) => `/schools/${encodeURIComponent(schoolId)}${path}`;

/** What an Invitation's secret names, and nothing else about it (ADR-0002). */
export interface InvitationInspection {
  school: { name: string };
  person: { displayName: string };
}

/**
 * Redeeming an Invitation has one field-level message beyond the generic
 * refusal: a taken username, reachable only once the secret itself is
 * accepted. `request`'s `ApiResult` cannot express that third outcome, so
 * this reads the status `send` returns instead, rather than collapsing it.
 */
async function redeemInvitation(credentials: {
  secret: string;
  username: string;
  password: string;
}): Promise<{ status: "redeemed" } | { status: "username_unavailable" } | { status: "refused" }> {
  const sent = await send("POST", "/invitations/redeem", credentials);
  if (sent?.status === 201) {
    return { status: "redeemed" };
  }
  if (sent?.status === 409) {
    return { status: "username_unavailable" };
  }
  return { status: "refused" };
}

export const api = {
  buildInfo: () => request<BuildInfo>("GET", "/build-info"),
  demo: () => request<{ accounts: DemoAccount[] }>("GET", "/demo"),
  signIn: (credentials: { username: string; password: string }) =>
    request<{ expiresAt: string }>("POST", "/session", credentials),
  session: () => request<Session>("GET", "/session"),
  signOut: () => request<undefined>("DELETE", "/session"),
  account: (schoolId: string) => request<{ account: OwnAccount }>("GET", inSchool(schoolId, "/account")),
  persons: (schoolId: string) => request<{ persons: ListedPerson[] }>("GET", inSchool(schoolId, "/persons")),
  createPerson: (schoolId: string, person: { displayName: string }) =>
    request<{ person: ListedPerson }>("POST", inSchool(schoolId, "/persons"), person),
  invitations: (schoolId: string) => request<{ invitations: Invitation[] }>("GET", inSchool(schoolId, "/invitations")),
  /** The one response that carries the Invitation's link. It cannot be asked for again. */
  issueInvitation: (schoolId: string, personId: string) =>
    request<{ invitation: Invitation; link: string }>("POST", inSchool(schoolId, "/invitations"), { personId }),
  revokeInvitation: (schoolId: string, invitationId: string) =>
    request<{ invitation: Invitation }>(
      "DELETE",
      inSchool(schoolId, `/invitations/${encodeURIComponent(invitationId)}`),
    ),
  memberships: (schoolId: string) =>
    request<{ memberships: Membership[] }>("GET", inSchool(schoolId, "/memberships")),
  /** Starts now. A missing `endsAt` leaves it with no end. */
  grantMembership: (schoolId: string, grant: { personId: string; role: Role; endsAt?: string }) =>
    request<{ membership: Membership }>("POST", inSchool(schoolId, "/memberships"), grant),
  /** Only a membership's end can change, and not into the past. */
  narrowMembership: (schoolId: string, membershipId: string, endsAt: string) =>
    request<{ membership: Membership }>(
      "PATCH",
      inSchool(schoolId, `/memberships/${encodeURIComponent(membershipId)}`),
      { endsAt },
    ),
  revokeMembership: (schoolId: string, membershipId: string) =>
    request<{ membership: Membership }>(
      "DELETE",
      inSchool(schoolId, `/memberships/${encodeURIComponent(membershipId)}`),
    ),
  enrollments: (schoolId: string) =>
    request<{ enrollments: Enrollment[] }>("GET", inSchool(schoolId, "/enrollments")),
  enroll: (schoolId: string, studentPersonId: string) =>
    request<{ enrollment: Enrollment }>("POST", inSchool(schoolId, "/enrollments"), { studentPersonId }),
  /** An Enrollment does not end without a reason. Every Guardian link to the Student ends with it. */
  endEnrollment: (schoolId: string, enrollmentId: string, reason: string) =>
    request<{ enrollment: Enrollment }>(
      "DELETE",
      inSchool(schoolId, `/enrollments/${encodeURIComponent(enrollmentId)}`),
      { reason },
    ),
  guardianLinks: (schoolId: string) =>
    request<{ guardianLinks: GuardianLink[] }>("GET", inSchool(schoolId, "/guardian-links")),
  /** Both permissions are stated: a profile is never left to a default. */
  linkGuardian: (
    schoolId: string,
    link: { guardianPersonId: string; studentPersonId: string; accessProfile: AccessProfile },
  ) => request<{ guardianLink: GuardianLink }>("POST", inSchool(schoolId, "/guardian-links"), link),
  /** Changes only the permissions named; the other stays as it stands. */
  setAccessProfile: (schoolId: string, guardianLinkId: string, accessProfile: Partial<AccessProfile>) =>
    request<{ guardianLink: GuardianLink }>(
      "PATCH",
      inSchool(schoolId, `/guardian-links/${encodeURIComponent(guardianLinkId)}`),
      { accessProfile },
    ),
  endGuardianLink: (schoolId: string, guardianLinkId: string) =>
    request<{ guardianLink: GuardianLink }>(
      "DELETE",
      inSchool(schoolId, `/guardian-links/${encodeURIComponent(guardianLinkId)}`),
    ),
  /**
   * One page of the School's trail: the newest, or the one after the record a
   * cursor from an earlier page names. Never the whole trail (ADR-0008).
   */
  auditRecords: (schoolId: string, cursor: string | null) =>
    request<AuditPage>(
      "GET",
      inSchool(schoolId, `/audit-records${cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`}`),
    ),
  /** The School's settings, with the timezones worth offering when changing its own. */
  schoolSettings: (schoolId: string) =>
    request<{ settings: SchoolSettings; timezones: string[] }>("GET", inSchool(schoolId, "/settings")),
  setTimezone: (schoolId: string, timezone: string) =>
    request<{ settings: SchoolSettings }>("PATCH", inSchool(schoolId, "/settings"), { timezone }),
  academicYears: (schoolId: string) =>
    request<{ academicYears: AcademicYear[] }>("GET", inSchool(schoolId, "/academic-years")),
  createAcademicYear: (schoolId: string, year: { name: string; firstDate: string; lastDate: string }) =>
    request<{ academicYear: AcademicYear }>("POST", inSchool(schoolId, "/academic-years"), year),
  /**
   * Changes a year's name and bounds, and states the whole of its Terms: one
   * left out is deleted. Every part lands together or none does, so the
   * boundary between two Terms moves in one change.
   */
  changeAcademicYear: (
    schoolId: string,
    academicYearId: string,
    change: { name: string; firstDate: string; lastDate: string; terms: ProposedTerm[] },
  ) =>
    request<{ academicYear: AcademicYear }>(
      "PATCH",
      inSchool(schoolId, `/academic-years/${encodeURIComponent(academicYearId)}`),
      change,
    ),
  /** Refused while the year still has Terms. */
  deleteAcademicYear: (schoolId: string, academicYearId: string) =>
    request<{ academicYear: AcademicYear }>(
      "DELETE",
      inSchool(schoolId, `/academic-years/${encodeURIComponent(academicYearId)}`),
    ),
  inspectInvitation: (secret: string) =>
    request<InvitationInspection>("POST", "/invitations/inspect", { secret }),
  redeemInvitation,
  /** Redeems as whichever account the browser's session belongs to. */
  redeemInvitationSignedIn: (secret: string) =>
    request<undefined>("POST", "/invitations/redeem-signed-in", { secret }),
};
