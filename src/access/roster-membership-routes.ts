import { appendAuditRecord, type AuditValues } from "../audit/index.ts";
import { schoolDateAt, type SchoolDate } from "../calendar/index.ts";
import type { Database } from "../db/pool.ts";
import { transactionTime, withTransaction, type Queryable } from "../db/transaction.ts";
import { InvalidRequest } from "../http/invalid-request.ts";
import { fieldsOf, reasonFrom, reasonOnly } from "../http/request-body.ts";
import type { SchoolScope } from "../http/school-scope.ts";
import { findPerson, type Person } from "../identity/index.ts";
import { lockOpenEnrollment, type Enrollment } from "./enrollments.ts";
import {
  authorizeManageRosterMembership,
  authorizeManageRosterMemberships,
  authorizeRoster,
  serveRosterMemberships,
  type Actor,
} from "./index.ts";
import {
  checkInOrder,
  checkNotExtended,
  firstDateFrom,
  lastDateFrom,
  lockPermittedOffering,
} from "./participation.ts";
import {
  deleteRosterMembership,
  endRosterMembershipsOf,
  findRosterMembership,
  lockRosterMembership,
  rosterStudent,
  setRosterMembershipBounds,
  type ChangedRosterMembership,
  type RosterMembership,
} from "./roster-memberships.ts";

/**
 * The most Students one request rosters. A class of any real size fits well
 * inside it; the bound is there so one request cannot hold a transaction open
 * over an unbounded list.
 */
const MAX_ROSTERED_AT_ONCE = 200;

/** A Roster membership as written to the Audit record, naming the offering and Person it joins. */
function valuesOf({ classOfferingId, personId, firstDate, lastDate }: RosterMembership): AuditValues {
  return { classOfferingId, personId, firstDate, lastDate };
}

async function served(database: Queryable, membership: RosterMembership) {
  return { rosterMembership: (await serveRosterMemberships(database, [membership]))[0]! };
}

type Action = "created" | "changed" | "ended" | "deleted";

async function recordChange(
  transaction: Queryable,
  actor: Actor,
  action: Action,
  { before, after }: ChangedRosterMembership,
  reason: string | null,
): Promise<void> {
  await appendAuditRecord(transaction, {
    schoolId: actor.schoolId,
    actorPersonId: actor.person.id,
    action: `roster_membership.${action}`,
    target: { type: "roster_membership", id: (after ?? before)!.id },
    reason,
    before: before === null ? null : valuesOf(before),
    after: after === null ? null : valuesOf(after),
  });
}

// Validation below runs only once the Access decision has permitted the
// caller: see InvalidRequest.

function parseRostering(body: unknown) {
  const fields = fieldsOf(body, ["personIds", "firstDate", "lastDate", "reason"]);
  const personIds = fields["personIds"];
  if (
    !Array.isArray(personIds) ||
    personIds.length === 0 ||
    !personIds.every((personId): personId is string => typeof personId === "string" && personId.length > 0)
  ) {
    throw new InvalidRequest("personIds must name at least one Person");
  }
  if (personIds.length > MAX_ROSTERED_AT_ONCE) {
    throw new InvalidRequest(`personIds may name at most ${MAX_ROSTERED_AT_ONCE} Persons`);
  }
  if (new Set(personIds).size !== personIds.length) {
    throw new InvalidRequest("personIds must name each Person once");
  }
  return {
    personIds,
    firstDate: firstDateFrom(fields),
    lastDate: lastDateFrom(fields),
    reason: reasonFrom(fields["reason"]),
  };
}

/** A change of bounds: whatever it states of them, over what the membership already holds. */
function parseBounds(body: unknown, membership: RosterMembership) {
  const fields = fieldsOf(body, ["firstDate", "lastDate", "reason"]);
  const lastDate = lastDateFrom(fields);
  return {
    firstDate: firstDateFrom(fields) ?? membership.firstDate,
    lastDate: lastDate === undefined ? membership.lastDate : lastDate,
    reason: reasonFrom(fields["reason"]),
  };
}

// Found, decided, and only then locked, as lockPermittedOffering is.
async function lockPermittedMembership(transaction: Queryable, actor: Actor, rosterMembershipId: string) {
  const permitted = authorizeManageRosterMembership(
    actor,
    rosterMembershipId,
    await findRosterMembership(transaction, rosterMembershipId),
  );
  return (
    (await lockRosterMembership(transaction, permitted)) ??
    authorizeManageRosterMembership<RosterMembership & { termLastDate: SchoolDate }>(actor, rosterMembershipId, null)
  );
}

/**
 * Ends the Roster memberships of the Student whose Enrollment this is, now it
 * has ended: each still running after the School date it ended on ends on it,
 * and each that would only have begun after it is removed. Every one is
 * recorded, as the change that ended the Enrollment, with its reason.
 *
 * Called by the transaction that ended the Enrollment, once it has, so the
 * two end together (CONTEXT.md: Enrollment).
 */
export async function endRosterWithEnrollment(
  transaction: Queryable,
  actor: Actor,
  enrollment: Enrollment,
  reason: string,
): Promise<void> {
  if (enrollment.endedAt === null) {
    return;
  }
  const endsOn = (await schoolDateAt(transaction, { schoolId: enrollment.schoolId, at: enrollment.endedAt }))!;
  const student = { id: enrollment.studentPersonId, schoolId: enrollment.schoolId };
  for (const changed of await endRosterMembershipsOf(transaction, student, endsOn)) {
    await recordChange(transaction, actor, changed.after === null ? "deleted" : "ended", changed, reason);
  }
}

/**
 * Roster memberships are made, changed, and ended by a School Administrator of
 * the School they belong to: every decision is the Access module's, asked
 * before anything else about the request is looked at, and every change is
 * recorded in the transaction that makes it.
 *
 * Several Students are rostered in one request, all or nothing: one who cannot
 * be rostered leaves every other unrostered too. Which offering and Person a
 * membership joins never changes. Ending one that has begun sets its last
 * School date to today's; one that has not begun is removed instead.
 */
export function registerRosterMembershipRoutes(scope: SchoolScope, database: Database): void {
  scope.post("/class-offerings/:classOfferingId/roster-memberships", async (actor, { params, body }) => {
    authorizeManageRosterMemberships(actor);
    const request = parseRostering(body);
    return withTransaction(database, async (transaction) => {
      const offering = await lockPermittedOffering(transaction, actor, params["classOfferingId"]!);
      const students: Person[] = [];
      for (const personId of request.personIds) {
        students.push(authorizeRoster(actor, personId, await findPerson(transaction, personId)));
      }
      // Each Enrollment is held until the transaction ends, so ending one waits
      // and then finds the membership this wrote, and ends it too. In one
      // order, so two requests rostering the same Students cannot deadlock.
      for (const student of [...students].sort((a, b) => a.id.localeCompare(b.id))) {
        if (!(await lockOpenEnrollment(transaction, student))) {
          throw new InvalidRequest("personIds must each name a Person holding an open Enrollment");
        }
      }
      const { term } = offering;
      const bounds = { firstDate: request.firstDate ?? term.firstDate, lastDate: request.lastDate ?? null };
      checkInOrder(bounds);
      const created: RosterMembership[] = [];
      for (const student of students) {
        const membership = await rosterStudent(transaction, {
          schoolId: offering.schoolId,
          classOfferingId: offering.id,
          personId: student.id,
          ...bounds,
        });
        await recordChange(transaction, actor, "created", { before: null, after: membership }, request.reason);
        created.push(membership);
      }
      return { rosterMemberships: await serveRosterMemberships(transaction, created) };
    });
  });

  scope.patch("/roster-memberships/:rosterMembershipId", async (actor, { params, body }) => {
    return withTransaction(database, async (transaction) => {
      const { termLastDate, ...membership } = await lockPermittedMembership(
        transaction,
        actor,
        params["rosterMembershipId"]!,
      );
      const { reason, ...bounds } = parseBounds(body, membership);
      const student = (await findPerson(transaction, membership.personId))!;
      if (!(await lockOpenEnrollment(transaction, student))) {
        checkNotExtended(bounds, membership, termLastDate, "the Student no longer holds an open Enrollment");
      }
      checkInOrder(bounds);
      const changed = await setRosterMembershipBounds(transaction, membership, bounds);
      if (changed === null) {
        return served(transaction, membership);
      }
      await recordChange(transaction, actor, "changed", changed, reason);
      return served(transaction, changed.after!);
    });
  });

  scope.delete("/roster-memberships/:rosterMembershipId", async (actor, { params, body }) => {
    return withTransaction(database, async (transaction) => {
      const { termLastDate, ...membership } = await lockPermittedMembership(
        transaction,
        actor,
        params["rosterMembershipId"]!,
      );
      const reason = reasonOnly(body);
      const at = await transactionTime(transaction);
      const today = (await schoolDateAt(transaction, { schoolId: membership.schoolId, at }))!;
      if (membership.firstDate > today) {
        await deleteRosterMembership(transaction, membership);
        await recordChange(transaction, actor, "deleted", { before: membership, after: null }, reason);
        return served(transaction, membership);
      }
      // Already over by today: nothing is ended, so nothing is recorded.
      if ((membership.lastDate ?? termLastDate) <= today) {
        return served(transaction, membership);
      }
      const ended = (await setRosterMembershipBounds(transaction, membership, { ...membership, lastDate: today }))!;
      await recordChange(transaction, actor, "ended", ended, reason);
      return served(transaction, ended.after!);
    });
  });
}
