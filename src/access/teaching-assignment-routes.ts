import { schoolDateAt, type SchoolDate } from "../calendar/index.ts";
import type { Database } from "../db/pool.ts";
import { withTransaction, type Queryable } from "../db/transaction.ts";
import { InvalidRequest } from "../http/invalid-request.ts";
import { fieldsOf, reasonFrom, reasonOnly } from "../http/request-body.ts";
import type { SchoolScope } from "../http/school-scope.ts";
import { findPerson, type Person } from "../identity/index.ts";
import {
  authorizeAssignTeaching,
  authorizeManageTeachingAssignments,
  lockPermittedOffering,
  lockPermittedParticipation,
  serveTeachingAssignments,
  type Actor,
} from "./index.ts";
import { holdActiveMembership, type Membership } from "./memberships.ts";
import {
  boundsFrom,
  checkInOrder,
  checkNotExtended,
  endEachWith,
  endToday,
  firstDateFrom,
  lastDateFrom,
  recordChange,
  type Bounds,
} from "./participation.ts";
import { teachingAssignments, type TeachingAssignment } from "./teaching-assignments.ts";

async function served(database: Queryable, assignment: TeachingAssignment) {
  return { teachingAssignment: (await serveTeachingAssignments(database, [assignment]))[0]! };
}

// Validation below runs only once the Access decision has permitted the
// caller: see InvalidRequest.

function parseAssignment(body: unknown) {
  const fields = fieldsOf(body, ["personId", "firstDate", "lastDate", "reason"]);
  const personId = fields["personId"];
  if (typeof personId !== "string" || personId.length === 0) {
    throw new InvalidRequest("personId must name a Person");
  }
  return {
    personId,
    firstDate: firstDateFrom(fields),
    lastDate: lastDateFrom(fields),
    reason: reasonFrom(fields["reason"]),
  };
}

/**
 * The School date through which this Person may teach: the one their Faculty
 * membership ends on, or null while it has no end, or undefined when they
 * hold no Faculty membership now. The membership is held until the
 * transaction ends, so it cannot end between this check and the write.
 */
async function teachesUntil(transaction: Queryable, person: Person): Promise<SchoolDate | null | undefined> {
  const membership = await holdActiveMembership(transaction, person, "faculty");
  if (membership === null) {
    return undefined;
  }
  return membership.endsAt === null
    ? null
    : (await schoolDateAt(transaction, { schoolId: person.schoolId, at: membership.endsAt }))!;
}

/**
 * Refuses bounds out of order, and bounds running past the School date the
 * Person's Faculty membership ends on: ending that membership would end the
 * assignment on that date anyway, so it is not written to run beyond it.
 */
function checkBounds(bounds: Bounds, termLastDate: SchoolDate, until: SchoolDate | null): void {
  checkInOrder(bounds);
  if (until !== null && (bounds.lastDate ?? termLastDate) > until) {
    throw new InvalidRequest(`the assignment may not run past ${until}, when the Person's Faculty membership ends`);
  }
}

/**
 * Ends the Teaching assignments of the Person whose membership this is, if it
 * is a Faculty membership and now has an end: each still running after the
 * School date that end falls on ends on it, and each that would only have
 * begun after it is removed. Every one is recorded, as the change that ended
 * the membership, with its reason.
 *
 * Called by the transaction that revoked or narrowed the membership, once it
 * has, so the membership and its assignments end together: what ending a
 * Faculty membership does (CONTEXT.md: Teaching assignment).
 */
export async function endTeachingWithMembership(
  transaction: Queryable,
  actor: Actor,
  membership: Membership,
  reason: string | null,
): Promise<void> {
  if (membership.role !== "faculty" || membership.endsAt === null) {
    return;
  }
  const endsOn = (await schoolDateAt(transaction, { schoolId: membership.schoolId, at: membership.endsAt }))!;
  const person = { id: membership.personId, schoolId: membership.schoolId };
  await endEachWith(transaction, actor, teachingAssignments, person, endsOn, reason);
}

/**
 * Teaching assignments are made, changed, and ended by a School
 * Administrator of the School they belong to: every decision is the Access
 * module's, asked before anything else about the request is looked at, and
 * every change is recorded in the transaction that makes it.
 *
 * Which offering and Person an assignment joins never changes. Ending one
 * that has begun sets its last School date to today's; one that has not begun
 * has taught nothing, and is removed instead.
 */
export function registerTeachingAssignmentRoutes(scope: SchoolScope, database: Database): void {
  scope.post("/class-offerings/:classOfferingId/teaching-assignments", async (actor, { params, body }) => {
    authorizeManageTeachingAssignments(actor);
    const request = parseAssignment(body);
    return withTransaction(database, async (transaction) => {
      const offering = await lockPermittedOffering(transaction, actor, params["classOfferingId"]!);
      const person = authorizeAssignTeaching(actor, request.personId, await findPerson(transaction, request.personId));
      const until = await teachesUntil(transaction, person);
      if (until === undefined) {
        throw new InvalidRequest("personId must name a Person holding an active Faculty membership");
      }
      const { term } = offering;
      const firstDate = request.firstDate ?? term.firstDate;
      // Unstated, it runs to the end of the Term, or to the end of the Faculty membership if that comes first.
      const lastDate = request.lastDate !== undefined ? request.lastDate : until !== null && until < term.lastDate ? until : null;
      checkBounds({ firstDate, lastDate }, term.lastDate, until);
      const created = await teachingAssignments.create(transaction, {
        schoolId: offering.schoolId,
        classOfferingId: offering.id,
        personId: person.id,
        firstDate,
        lastDate,
      });
      await recordChange(transaction, actor, teachingAssignments, "created", { before: null, after: created }, request.reason);
      return served(transaction, created);
    });
  });

  scope.patch("/teaching-assignments/:teachingAssignmentId", async (actor, { params, body }) => {
    return withTransaction(database, async (transaction) => {
      const { termLastDate, ...assignment } = await lockPermittedParticipation(
        transaction,
        actor,
        teachingAssignments,
        params["teachingAssignmentId"]!,
      );
      const { reason, ...bounds } = boundsFrom(body, assignment);
      const until = await teachesUntil(transaction, (await findPerson(transaction, assignment.personId))!);
      if (until === undefined) {
        checkNotExtended(bounds, assignment, termLastDate, "the Person no longer holds a Faculty membership");
      }
      checkBounds(bounds, termLastDate, until ?? null);
      const changed = await teachingAssignments.setBounds(transaction, assignment, bounds);
      if (changed === null) {
        return served(transaction, assignment);
      }
      await recordChange(transaction, actor, teachingAssignments, "changed", changed, reason);
      return served(transaction, changed.after!);
    });
  });

  scope.delete("/teaching-assignments/:teachingAssignmentId", async (actor, { params, body }) => {
    return withTransaction(database, async (transaction) => {
      const assignment = await lockPermittedParticipation(
        transaction,
        actor,
        teachingAssignments,
        params["teachingAssignmentId"]!,
      );
      const reason = reasonOnly(body);
      return served(transaction, await endToday(transaction, actor, teachingAssignments, assignment, reason));
    });
  });
}
