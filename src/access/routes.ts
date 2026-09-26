import type { FastifyInstance } from "fastify";
import type { Authenticator } from "../authentication/index.ts";
import { appendAuditRecord, type AuditValues } from "../audit/index.ts";
import type { Database } from "../db/pool.ts";
import { midnightOn, schoolDateAt } from "../calendar/index.ts";
import { transactionTime, withTransaction, type Queryable } from "../db/transaction.ts";
import { InvalidRequest } from "../http/invalid-request.ts";
import { fieldsOf, instantFrom, reasonFrom, reasonOnly, schoolDateFrom } from "../http/request-body.ts";
import { registerSchoolScope } from "../http/school-scope.ts";
import { findPerson } from "../identity/index.ts";
import { registerEnrollmentRoutes } from "./enrollment-routes.ts";
import { registerGuardianLinkRoutes } from "./guardian-link-routes.ts";
import { registerRosterMembershipRoutes } from "./roster-membership-routes.ts";
import { endTeachingWithMembership, registerTeachingAssignmentRoutes } from "./teaching-assignment-routes.ts";
import { countTeachingAssignmentsRunningPast } from "./teaching-assignments.ts";
import {
  authorizeGrantMembershipTo,
  authorizeManageMembership,
  authorizeManageMemberships,
  ownAccount,
  type Actor,
} from "./index.ts";
import {
  endMembershipNow,
  findMembership,
  grantMembership,
  hasEnded,
  holdsRoleDuring,
  isRole,
  lockMembership,
  membershipsInSchool,
  ROLES,
  setMembershipEnd,
  type Membership,
} from "./memberships.ts";

/** A membership as served, and as written to the Audit record. The School is the one addressed. */
function present({ id, personId, role, startsAt, endsAt }: Membership) {
  return { id, ...valuesOf({ personId, role, startsAt, endsAt }) };
}

function valuesOf({
  personId,
  role,
  startsAt,
  endsAt,
}: Omit<Membership, "id" | "schoolId">): AuditValues & { endsAt: string | null } {
  return {
    personId,
    role,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt?.toISOString() ?? null,
  };
}

// Validation below runs only once the Access decision has permitted the
// caller: see InvalidRequest.

/**
 * When a request says a membership ends, or undefined when it says nothing:
 * `endsAt`, an instant, or `endsOn`, a School date, which ends it at midnight
 * on that date in the School's timezone. The Admin console names a date, so
 * the day picked is the School's whatever timezone the browser keeps.
 */
async function endNamed(
  database: Queryable,
  schoolId: string,
  fields: Record<string, unknown>,
): Promise<Date | null | undefined> {
  if ("endsOn" in fields) {
    if ("endsAt" in fields) {
      throw new InvalidRequest("name endsAt or endsOn, not both");
    }
    return (await midnightOn(database, { schoolId, date: schoolDateFrom(fields["endsOn"], "endsOn") }))!;
  }
  if (!("endsAt" in fields)) {
    return undefined;
  }
  return fields["endsAt"] === null ? null : instantFrom(fields["endsAt"], "endsAt");
}

/**
 * A grant's bounds may not reach into the past. A membership records when
 * access began and ended; a start or end already gone by would claim access
 * that was never held, or deny access that was.
 */
async function parseGrant(transaction: Queryable, schoolId: string, body: unknown, now: Date) {
  const fields = fieldsOf(body, ["personId", "role", "startsAt", "endsAt", "endsOn", "reason"]);
  const { personId, role } = fields;
  if (typeof personId !== "string" || personId.length === 0) {
    throw new InvalidRequest("personId must name a Person");
  }
  if (!isRole(role)) {
    throw new InvalidRequest(`role must be exactly one of ${ROLES.join(", ")}`);
  }
  const startsAt = fields["startsAt"] == null ? null : instantFrom(fields["startsAt"], "startsAt");
  if (startsAt !== null && startsAt < now) {
    throw new InvalidRequest("startsAt may not be in the past");
  }
  const endsAt = (await endNamed(transaction, schoolId, fields)) ?? null;
  if (endsAt !== null && endsAt <= (startsAt ?? now)) {
    throw new InvalidRequest("the end must be after the membership starts");
  }
  return { personId, role, startsAt: startsAt ?? now, endsAt, reason: reasonFrom(fields["reason"]) };
}

/** Only a membership's end can change, and not into the past, for the same reason as a grant. */
async function parseChange(transaction: Queryable, body: unknown, membership: Membership, now: Date) {
  const fields = fieldsOf(body, ["endsAt", "endsOn", "reason"]);
  const endsAt = await endNamed(transaction, membership.schoolId, fields);
  if (endsAt === undefined) {
    throw new InvalidRequest("endsAt or endsOn is required");
  }
  if (hasEnded(membership, now)) {
    throw new InvalidRequest("a membership that has ended cannot change");
  }
  // Ending a membership at or before its start is revoking it, and is recorded as that.
  if (endsAt !== null && (endsAt <= now || endsAt <= membership.startsAt)) {
    throw new InvalidRequest("the end must be in the future, and after the membership starts");
  }
  return { endsAt, reason: reasonFrom(fields["reason"]) };
}

/**
 * The membership the actor may change or revoke, locked for the rest of the
 * transaction. The decision comes first and the lock second: see lockMembership.
 */
async function lockPermitted(
  transaction: Queryable,
  actor: Actor,
  membershipId: string,
): Promise<Membership> {
  const permitted = authorizeManageMembership(
    actor,
    membershipId,
    await findMembership(transaction, membershipId),
  );
  return lockMembership(transaction, permitted);
}

async function recordChange(
  transaction: Queryable,
  actor: Actor,
  action: "membership.granted" | "membership.changed" | "membership.revoked",
  { before, after, reason }: { before: Membership | null; after: Membership; reason: string | null },
): Promise<void> {
  await appendAuditRecord(transaction, {
    schoolId: actor.schoolId,
    actorPersonId: actor.person.id,
    action,
    target: { type: "membership", id: after.id },
    reason,
    before: before === null ? null : valuesOf(before),
    after: valuesOf(after),
  });
}

/**
 * Memberships are granted, changed, and revoked by a School Administrator of
 * the School they belong to. Every one of those decisions is the Access
 * module's, asked before anything else about the request is looked at; and
 * every change is recorded in the same transaction that makes it, so it does
 * not happen unrecorded.
 */
export function registerAccessRoutes(
  app: FastifyInstance,
  database: Database,
  authenticator: Authenticator,
): void {
  registerSchoolScope(app, database, authenticator, (scope) => {
    /*
     * The actor's own standing in this School, and nothing of anyone else's
     * beyond the Students their Guardian links already reach. Every actor
     * resolved into the School reaches it, so there is no further decision to
     * ask for: one who holds no membership in force never got this far
     * (see resolveActor).
     */
    scope.get("/account", async (actor) => {
      return { account: await ownAccount(database, actor) };
    });

    scope.get("/memberships", async (actor) => {
      const schoolId = authorizeManageMemberships(actor);
      return { memberships: (await membershipsInSchool(database, schoolId)).map(present) };
    });

    scope.post("/memberships", async (actor, { body }) => {
      const schoolId = authorizeManageMemberships(actor);
      return withTransaction(database, async (transaction) => {
        const grant = await parseGrant(transaction, schoolId, body, await transactionTime(transaction));
        const person = authorizeGrantMembershipTo(
          actor,
          grant.personId,
          await findPerson(transaction, grant.personId),
        );
        if (await holdsRoleDuring(transaction, { person, ...grant })) {
          throw new InvalidRequest("the Person already holds this role for some of that time");
        }
        const membership = await grantMembership(transaction, { person, ...grant });
        await recordChange(transaction, actor, "membership.granted", {
          before: null,
          after: membership,
          reason: grant.reason,
        });
        return { membership: present(membership) };
      });
    });

    scope.patch("/memberships/:membershipId", async (actor, { params, body }) => {
      return withTransaction(database, async (transaction) => {
        const membership = await lockPermitted(transaction, actor, params["membershipId"]!);
        const change = await parseChange(transaction, body, membership, await transactionTime(transaction));
        const changed = await setMembershipEnd(transaction, membership.id, change.endsAt);
        await recordChange(transaction, actor, "membership.changed", {
          before: membership,
          after: changed,
          reason: change.reason,
        });
        await endTeachingWithMembership(transaction, actor, changed, change.reason);
        return { membership: present(changed) };
      });
    });

    // Revoking ends a membership rather than deleting it: the row is the record
    // of when access was held. Every other membership the Person holds is a row
    // of its own, and is not touched.
    scope.delete("/memberships/:membershipId", async (actor, { params, body }) => {
      return withTransaction(database, async (transaction) => {
        const membership = await lockPermitted(transaction, actor, params["membershipId"]!);
        const reason = reasonOnly(body);
        // Already ended: nothing is revoked, so nothing is recorded.
        if (hasEnded(membership, await transactionTime(transaction))) {
          return { membership: present(membership) };
        }
        const revoked = await endMembershipNow(transaction, membership.id);
        await recordChange(transaction, actor, "membership.revoked", {
          before: membership,
          after: revoked,
          reason,
        });
        await endTeachingWithMembership(transaction, actor, revoked, reason);
        return { membership: present(revoked) };
      });
    });

    /*
     * What ending a membership at this instant would end with it, counted so a
     * confirmation can name it before anything changes: a Faculty membership's
     * Teaching assignments. Ending it now is revoking it, which ends it no
     * earlier than its start. The instant is `endsAt` or `endsOn`, as a grant
     * or change names it, or now when neither is.
     */
    scope.get("/memberships/:membershipId/consequences", async (actor, { params, query }) => {
      const membershipId = params["membershipId"]!;
      const membership = authorizeManageMembership(actor, membershipId, await findMembership(database, membershipId));
      const at = (await endNamed(database, membership.schoolId, query)) ?? (await transactionTime(database));
      if (membership.role !== "faculty") {
        return { consequences: { teachingAssignments: 0 } };
      }
      const endsAt = at < membership.startsAt ? membership.startsAt : at;
      const endsOn = (await schoolDateAt(database, { schoolId: membership.schoolId, at: endsAt }))!;
      const person = { id: membership.personId, schoolId: membership.schoolId };
      return { consequences: { teachingAssignments: await countTeachingAssignmentsRunningPast(database, person, endsOn) } };
    });

    registerGuardianLinkRoutes(scope, database);
    registerTeachingAssignmentRoutes(scope, database);
    registerRosterMembershipRoutes(scope, database);
    registerEnrollmentRoutes(scope, database);
  });
}
