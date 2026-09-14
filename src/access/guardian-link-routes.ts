import { appendAuditRecord, type AuditValues } from "../audit/index.ts";
import type { Database } from "../db/pool.ts";
import { withTransaction, type Queryable } from "../db/transaction.ts";
import { InvalidRequest } from "../http/invalid-request.ts";
import { fieldsOf, reasonFrom, reasonOnly } from "../http/request-body.ts";
import type { SchoolScope } from "../http/school-scope.ts";
import { findPerson } from "../identity/index.ts";
import {
  authorizeLinkGuardian,
  authorizeManageGuardianLink,
  authorizeManageGuardianLinks,
  type Actor,
} from "./index.ts";
import {
  endGuardianLinkNow,
  findGuardianLink,
  guardianLinksInSchool,
  linkGuardian,
  lockGuardianLink,
  setAccessProfile,
  type AccessProfile,
  type GuardianLink,
} from "./guardian-links.ts";
import { holdsRoleNowOrLater } from "./memberships.ts";

/** A Guardian link as served. The School is the one addressed. */
function present({ id, guardianPersonId, studentPersonId, accessProfile, createdAt, endedAt }: GuardianLink) {
  return {
    id,
    guardianPersonId,
    studentPersonId,
    accessProfile,
    createdAt: createdAt.toISOString(),
    endedAt: endedAt?.toISOString() ?? null,
  };
}

/** A Guardian link as written to the Audit record, which holds only flat values. */
function valuesOf(link: GuardianLink): AuditValues {
  const { id: _id, accessProfile, ...values } = present(link);
  return { ...values, ...accessProfile };
}

// Validation below runs only once the Access decision has permitted the
// caller: see InvalidRequest.

const PERMISSIONS = ["attendanceRead", "resultsRead"] as const;

/**
 * The permissions stated in a body's `accessProfile`, each true or false. On a
 * new link both must be stated: a profile is never left to a default.
 */
function permissionsFrom(value: unknown): Partial<AccessProfile> {
  if (value === undefined) {
    throw new InvalidRequest("accessProfile is required");
  }
  const fields = fieldsOf(value, PERMISSIONS);
  const permissions: Partial<AccessProfile> = {};
  for (const permission of PERMISSIONS) {
    const stated = fields[permission];
    if (stated !== undefined && typeof stated !== "boolean") {
      throw new InvalidRequest(`accessProfile.${permission} must be true or false`);
    }
    if (stated !== undefined) {
      permissions[permission] = stated;
    }
  }
  return permissions;
}

function accessProfileFrom(value: unknown): AccessProfile {
  const { attendanceRead, resultsRead } = permissionsFrom(value);
  if (attendanceRead === undefined || resultsRead === undefined) {
    throw new InvalidRequest("accessProfile must state both attendanceRead and resultsRead");
  }
  return { attendanceRead, resultsRead };
}

function sameProfile(a: AccessProfile, b: AccessProfile): boolean {
  return PERMISSIONS.every((permission) => a[permission] === b[permission]);
}

function personIdFrom(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidRequest(`${field} must name a Person`);
  }
  return value;
}

/**
 * Only the profile can change, and only the permissions named: each is
 * independent of the other, so changing one leaves the other as it stands.
 */
function parseChange(body: unknown, link: GuardianLink) {
  const fields = fieldsOf(body, ["accessProfile", "reason"]);
  const stated = permissionsFrom(fields["accessProfile"]);
  if (Object.keys(stated).length === 0) {
    throw new InvalidRequest("accessProfile must set at least one permission");
  }
  if (link.endedAt !== null) {
    throw new InvalidRequest("a Guardian link that has ended cannot change");
  }
  return {
    accessProfile: { ...link.accessProfile, ...stated },
    reason: reasonFrom(fields["reason"]),
  };
}

function parseLink(body: unknown) {
  const fields = fieldsOf(body, ["guardianPersonId", "studentPersonId", "accessProfile", "reason"]);
  return {
    guardianPersonId: personIdFrom(fields["guardianPersonId"], "guardianPersonId"),
    studentPersonId: personIdFrom(fields["studentPersonId"], "studentPersonId"),
    accessProfile: accessProfileFrom(fields["accessProfile"]),
    reason: reasonFrom(fields["reason"]),
  };
}

async function recordChange(
  transaction: Queryable,
  actor: Actor,
  action: "guardian_link.created" | "guardian_link.changed" | "guardian_link.revoked",
  { before, after, reason }: { before: GuardianLink | null; after: GuardianLink; reason: string | null },
): Promise<void> {
  await appendAuditRecord(transaction, {
    schoolId: actor.schoolId,
    actorPersonId: actor.person.id,
    action,
    target: { type: "guardian_link", id: after.id },
    reason,
    before: before === null ? null : valuesOf(before),
    after: valuesOf(after),
  });
}

/**
 * Guardian links are created, changed, and revoked by a School Administrator
 * of the School they belong to, as memberships are: every decision is the
 * Access module's, asked before anything else about the request is looked at,
 * and every change is recorded in the transaction that makes it.
 */
export function registerGuardianLinkRoutes(scope: SchoolScope, database: Database): void {
  scope.get("/guardian-links", async (actor) => {
    const schoolId = authorizeManageGuardianLinks(actor);
    return { guardianLinks: (await guardianLinksInSchool(database, schoolId)).map(present) };
  });

  scope.post("/guardian-links", async (actor, { body }) => {
    authorizeManageGuardianLinks(actor);
    const request = parseLink(body);
    return withTransaction(database, async (transaction) => {
      const { guardian, student } = authorizeLinkGuardian(
        actor,
        { personId: request.guardianPersonId, person: await findPerson(transaction, request.guardianPersonId) },
        { personId: request.studentPersonId, person: await findPerson(transaction, request.studentPersonId) },
      );
      if (guardian.id === student.id) {
        throw new InvalidRequest("a Student cannot be their own Guardian");
      }
      // Linking confers no role. A link is only between a Person the School holds
      // as a Guardian and one it holds as a Student, now or from a later start.
      if (!(await holdsRoleNowOrLater(transaction, guardian, "guardian"))) {
        throw new InvalidRequest("guardianPersonId must name a Person holding a Guardian membership");
      }
      if (!(await holdsRoleNowOrLater(transaction, student, "student"))) {
        throw new InvalidRequest("studentPersonId must name a Person holding a Student membership");
      }
      const link = await linkGuardian(transaction, { guardian, student, ...request });
      if (link === null) {
        throw new InvalidRequest("the Guardian is already linked to this Student");
      }
      await recordChange(transaction, actor, "guardian_link.created", {
        before: null,
        after: link,
        reason: request.reason,
      });
      return { guardianLink: present(link) };
    });
  });

  scope.patch("/guardian-links/:guardianLinkId", async (actor, { params, body }) => {
    return withTransaction(database, async (transaction) => {
      const link = await lockPermitted(transaction, actor, params["guardianLinkId"]!);
      const change = parseChange(body, link);
      // Stating the profile the link already has changes nothing, so nothing is recorded.
      if (sameProfile(change.accessProfile, link.accessProfile)) {
        return { guardianLink: present(link) };
      }
      const changed = await setAccessProfile(transaction, link.id, change.accessProfile);
      await recordChange(transaction, actor, "guardian_link.changed", {
        before: link,
        after: changed,
        reason: change.reason,
      });
      return { guardianLink: present(changed) };
    });
  });

  // Revoking ends a link rather than deleting it. Every other link the Guardian
  // holds is a row of its own, and is not touched.
  scope.delete("/guardian-links/:guardianLinkId", async (actor, { params, body }) => {
    return withTransaction(database, async (transaction) => {
      const link = await lockPermitted(transaction, actor, params["guardianLinkId"]!);
      const reason = reasonOnly(body);
      // Already ended: nothing is revoked, so nothing is recorded.
      if (link.endedAt !== null) {
        return { guardianLink: present(link) };
      }
      const revoked = await endGuardianLinkNow(transaction, link.id);
      await recordChange(transaction, actor, "guardian_link.revoked", {
        before: link,
        after: revoked,
        reason,
      });
      return { guardianLink: present(revoked) };
    });
  });
}

/**
 * The link the actor may change or revoke, locked for the rest of the
 * transaction. The decision comes first and the lock second: see lockGuardianLink.
 */
async function lockPermitted(
  transaction: Queryable,
  actor: Actor,
  guardianLinkId: string,
): Promise<GuardianLink> {
  const permitted = authorizeManageGuardianLink(
    actor,
    guardianLinkId,
    await findGuardianLink(transaction, guardianLinkId),
  );
  return lockGuardianLink(transaction, permitted);
}
