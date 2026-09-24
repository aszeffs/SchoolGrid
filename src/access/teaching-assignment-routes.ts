import { findClassOffering, lockClassOffering, type DescribedClassOffering } from "../academic-structure/courses.ts";
import { appendAuditRecord, type AuditValues } from "../audit/index.ts";
import { schoolDateAt, type SchoolDate } from "../calendar/index.ts";
import type { Database } from "../db/pool.ts";
import { transactionTime, withTransaction, type Queryable } from "../db/transaction.ts";
import { InvalidRequest } from "../http/invalid-request.ts";
import { fieldsOf, reasonFrom, reasonOnly, schoolDateFrom } from "../http/request-body.ts";
import type { SchoolScope } from "../http/school-scope.ts";
import { findPerson, type Person } from "../identity/index.ts";
import {
  authorizeAssignTeaching,
  authorizeManageClassOffering,
  authorizeManageTeachingAssignment,
  authorizeManageTeachingAssignments,
  serveTeachingAssignments,
  type Actor,
} from "./index.ts";
import { holdActiveMembership, type Membership } from "./memberships.ts";
import {
  assignTeaching,
  deleteTeachingAssignment,
  endTeachingAssignmentsOf,
  findTeachingAssignment,
  lockTeachingAssignment,
  setTeachingAssignmentBounds,
  type ChangedAssignment,
  type TeachingAssignment,
} from "./teaching-assignments.ts";

/** A Teaching assignment as written to the Audit record, naming the offering and Person it joins. */
function valuesOf({ classOfferingId, personId, firstDate, lastDate }: TeachingAssignment): AuditValues {
  return { classOfferingId, personId, firstDate, lastDate };
}

async function served(database: Queryable, assignment: TeachingAssignment) {
  return { teachingAssignment: (await serveTeachingAssignments(database, [assignment]))[0]! };
}

type Action = "created" | "changed" | "ended" | "deleted";

async function recordChange(
  transaction: Queryable,
  actor: Actor,
  action: Action,
  { before, after }: ChangedAssignment,
  reason: string | null,
): Promise<void> {
  await appendAuditRecord(transaction, {
    schoolId: actor.schoolId,
    actorPersonId: actor.person.id,
    action: `teaching_assignment.${action}`,
    target: { type: "teaching_assignment", id: (after ?? before)!.id },
    reason,
    before: before === null ? null : valuesOf(before),
    after: after === null ? null : valuesOf(after),
  });
}

// Validation below runs only once the Access decision has permitted the
// caller: see InvalidRequest.

/** A last date: absent when not stated, null for an open assignment, or a School date. */
function lastDateFrom(fields: Record<string, unknown>): SchoolDate | null | undefined {
  const value = fields["lastDate"];
  return value === undefined || value === null ? value : schoolDateFrom(value, "lastDate");
}

function parseAssignment(body: unknown) {
  const fields = fieldsOf(body, ["personId", "firstDate", "lastDate", "reason"]);
  const personId = fields["personId"];
  if (typeof personId !== "string" || personId.length === 0) {
    throw new InvalidRequest("personId must name a Person");
  }
  return {
    personId,
    firstDate: fields["firstDate"] === undefined ? undefined : schoolDateFrom(fields["firstDate"], "firstDate"),
    lastDate: lastDateFrom(fields),
    reason: reasonFrom(fields["reason"]),
  };
}

/** A change of bounds: whatever it states of them, over what the assignment already holds. */
function parseBounds(body: unknown, assignment: TeachingAssignment) {
  const fields = fieldsOf(body, ["firstDate", "lastDate", "reason"]);
  const lastDate = lastDateFrom(fields);
  return {
    firstDate:
      fields["firstDate"] === undefined ? assignment.firstDate : schoolDateFrom(fields["firstDate"], "firstDate"),
    lastDate: lastDate === undefined ? assignment.lastDate : lastDate,
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
 * Refuses bounds reaching beyond the assignment's own, for one whose Person no
 * longer holds a Faculty membership: it can still be corrected or shortened,
 * as a record of what they taught, but not made to teach more.
 */
function checkNotExtended(
  bounds: { firstDate: SchoolDate; lastDate: SchoolDate | null },
  assignment: TeachingAssignment,
  termLastDate: SchoolDate,
): void {
  if (
    bounds.firstDate < assignment.firstDate ||
    (bounds.lastDate ?? termLastDate) > (assignment.lastDate ?? termLastDate)
  ) {
    throw new InvalidRequest("the assignment may not be extended, as the Person no longer holds a Faculty membership");
  }
}

/**
 * Refuses bounds out of order, and bounds running past the School date the
 * Person's Faculty membership ends on: ending that membership would end the
 * assignment on that date anyway, so it is not written to run beyond it.
 */
function checkBounds(
  { firstDate, lastDate }: { firstDate: SchoolDate; lastDate: SchoolDate | null },
  termLastDate: SchoolDate,
  until: SchoolDate | null,
): void {
  if (lastDate !== null && lastDate < firstDate) {
    throw new InvalidRequest("lastDate must not be before firstDate");
  }
  if (until !== null && (lastDate ?? termLastDate) > until) {
    throw new InvalidRequest(`the assignment may not run past ${until}, when the Person's Faculty membership ends`);
  }
}

/*
 * Each record the actor may act on is found, decided, and only then locked:
 * see lockMembership. One deleted between the two is decided again as the
 * absent record it now is, so the caller is refused as for any other.
 */

async function lockPermittedOffering(
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

async function lockPermittedAssignment(transaction: Queryable, actor: Actor, teachingAssignmentId: string) {
  const permitted = authorizeManageTeachingAssignment(
    actor,
    teachingAssignmentId,
    await findTeachingAssignment(transaction, teachingAssignmentId),
  );
  return (
    (await lockTeachingAssignment(transaction, permitted)) ??
    authorizeManageTeachingAssignment<TeachingAssignment & { termLastDate: SchoolDate }>(actor, teachingAssignmentId, null)
  );
}

/**
 * Ends the Teaching assignments of the Person whose membership this is, if it
 * is a Faculty membership and now has an end: each still running after the
 * School date that end falls on ends on it, and each that would only have
 * begun after it is removed. Every one is recorded, as the change that ended
 * the membership, with its reason.
 *
 * Called by the transaction that revoked or narrowed the membership, once it
 * has, so the membership and its assignments end together (CONTEXT.md:
 * Teaching assignment).
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
  for (const changed of await endTeachingAssignmentsOf(transaction, person, endsOn)) {
    await recordChange(transaction, actor, changed.after === null ? "deleted" : "ended", changed, reason);
  }
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
      const created = await assignTeaching(transaction, {
        schoolId: offering.schoolId,
        classOfferingId: offering.id,
        personId: person.id,
        firstDate,
        lastDate,
      });
      await recordChange(transaction, actor, "created", { before: null, after: created }, request.reason);
      return served(transaction, created);
    });
  });

  scope.patch("/teaching-assignments/:teachingAssignmentId", async (actor, { params, body }) => {
    return withTransaction(database, async (transaction) => {
      const { termLastDate, ...assignment } = await lockPermittedAssignment(
        transaction,
        actor,
        params["teachingAssignmentId"]!,
      );
      const { reason, ...bounds } = parseBounds(body, assignment);
      const until = await teachesUntil(transaction, (await findPerson(transaction, assignment.personId))!);
      if (until === undefined) {
        checkNotExtended(bounds, assignment, termLastDate);
      }
      checkBounds(bounds, termLastDate, until ?? null);
      const changed = await setTeachingAssignmentBounds(transaction, assignment, bounds);
      if (changed === null) {
        return served(transaction, assignment);
      }
      await recordChange(transaction, actor, "changed", changed, reason);
      return served(transaction, changed.after!);
    });
  });

  scope.delete("/teaching-assignments/:teachingAssignmentId", async (actor, { params, body }) => {
    return withTransaction(database, async (transaction) => {
      const { termLastDate, ...assignment } = await lockPermittedAssignment(
        transaction,
        actor,
        params["teachingAssignmentId"]!,
      );
      const reason = reasonOnly(body);
      const at = await transactionTime(transaction);
      const today = (await schoolDateAt(transaction, { schoolId: assignment.schoolId, at }))!;
      if (assignment.firstDate > today) {
        await deleteTeachingAssignment(transaction, assignment);
        await recordChange(transaction, actor, "deleted", { before: assignment, after: null }, reason);
        return served(transaction, assignment);
      }
      // Already over by today: nothing is ended, so nothing is recorded.
      if ((assignment.lastDate ?? termLastDate) <= today) {
        return served(transaction, assignment);
      }
      const ended = (await setTeachingAssignmentBounds(transaction, assignment, { ...assignment, lastDate: today }))!;
      await recordChange(transaction, actor, "ended", ended, reason);
      return served(transaction, ended.after!);
    });
  });
}
