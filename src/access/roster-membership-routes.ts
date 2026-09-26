import { schoolDateAt } from "../calendar/index.ts";
import type { Database } from "../db/pool.ts";
import { withTransaction, type Queryable } from "../db/transaction.ts";
import { InvalidRequest } from "../http/invalid-request.ts";
import { fieldsOf, reasonFrom, reasonOnly } from "../http/request-body.ts";
import type { SchoolScope } from "../http/school-scope.ts";
import { findPerson, type Person } from "../identity/index.ts";
import { lockOpenEnrollment, type Enrollment } from "./enrollments.ts";
import {
  authorizeManageRosterMemberships,
  authorizeRoster,
  lockPermittedOffering,
  lockPermittedParticipation,
  serveRosterMemberships,
  type Actor,
} from "./index.ts";
import {
  boundsFrom,
  checkInOrder,
  checkNotExtended,
  endEachWith,
  endToday,
  firstDateFrom,
  lastDateFrom,
  recordChange,
} from "./participation.ts";
import { rosterMemberships, type RosterMembership } from "./roster-memberships.ts";

/**
 * The most Students one request rosters. A Class Offering of any real size fits well
 * inside it; the bound is there so one request cannot hold a transaction open
 * over an unbounded list.
 */
const MAX_ROSTERED_AT_ONCE = 200;

async function served(database: Queryable, membership: RosterMembership) {
  return { rosterMembership: (await serveRosterMemberships(database, [membership]))[0]! };
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

/**
 * Ends the Roster memberships of the Student whose Enrollment this is, now it
 * has ended: each still running after the School date it ended on ends on it,
 * and each that would only have begun after it is removed. Every one is
 * recorded, as the change that ended the Enrollment, with its reason.
 *
 * Called by the transaction that ended the Enrollment, once it has, so the
 * two end together: what ending an Enrollment does (CONTEXT.md: Enrollment).
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
  await endEachWith(transaction, actor, rosterMemberships, student, endsOn, reason);
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
        const membership = await rosterMemberships.create(transaction, {
          schoolId: offering.schoolId,
          classOfferingId: offering.id,
          personId: student.id,
          ...bounds,
        });
        await recordChange(
          transaction,
          actor,
          rosterMemberships,
          "created",
          { before: null, after: membership },
          request.reason,
        );
        created.push(membership);
      }
      return { rosterMemberships: await serveRosterMemberships(transaction, created) };
    });
  });

  scope.patch("/roster-memberships/:rosterMembershipId", async (actor, { params, body }) => {
    return withTransaction(database, async (transaction) => {
      const { termLastDate, ...membership } = await lockPermittedParticipation(
        transaction,
        actor,
        rosterMemberships,
        params["rosterMembershipId"]!,
      );
      const { reason, ...bounds } = boundsFrom(body, membership);
      const student = (await findPerson(transaction, membership.personId))!;
      if (!(await lockOpenEnrollment(transaction, student))) {
        checkNotExtended(bounds, membership, termLastDate, "the Student no longer holds an open Enrollment");
      }
      checkInOrder(bounds);
      const changed = await rosterMemberships.setBounds(transaction, membership, bounds);
      if (changed === null) {
        return served(transaction, membership);
      }
      await recordChange(transaction, actor, rosterMemberships, "changed", changed, reason);
      return served(transaction, changed.after!);
    });
  });

  scope.delete("/roster-memberships/:rosterMembershipId", async (actor, { params, body }) => {
    return withTransaction(database, async (transaction) => {
      const membership = await lockPermittedParticipation(
        transaction,
        actor,
        rosterMemberships,
        params["rosterMembershipId"]!,
      );
      const reason = reasonOnly(body);
      return served(transaction, await endToday(transaction, actor, rosterMemberships, membership, reason));
    });
  });
}
