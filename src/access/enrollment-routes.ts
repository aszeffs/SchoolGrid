import { appendAuditRecord, type AuditValues } from "../audit/index.ts";
import type { Database } from "../db/pool.ts";
import { withTransaction, type Queryable } from "../db/transaction.ts";
import { InvalidRequest } from "../http/invalid-request.ts";
import { fieldsOf, reasonFrom } from "../http/request-body.ts";
import type { SchoolScope } from "../http/school-scope.ts";
import { findPerson } from "../identity/index.ts";
import {
  endEnrollmentNow,
  enrollmentsInSchool,
  findEnrollment,
  lockEnrollment,
  recordEnrollment,
  type Enrollment,
} from "./enrollments.ts";
import { recordGuardianLinkChange } from "./guardian-link-routes.ts";
import { endGuardianLinksTo } from "./guardian-links.ts";
import {
  authorizeEnroll,
  authorizeManageEnrollment,
  authorizeManageEnrollments,
  type Actor,
} from "./index.ts";
import { holdsRoleNowOrLater } from "./memberships.ts";

/** An Enrollment as served. The School is the one addressed. */
function present({ id, studentPersonId, startedAt, endedAt, endReason }: Enrollment) {
  return {
    id,
    studentPersonId,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt?.toISOString() ?? null,
    endReason,
  };
}

/**
 * An Enrollment as written to the Audit record. Why it ended is the record's
 * own reason, so it is not repeated among the values.
 */
function valuesOf(enrollment: Enrollment): AuditValues {
  const { id: _id, endReason: _endReason, ...values } = present(enrollment);
  return values;
}

// Validation below runs only once the Access decision has permitted the
// caller: see InvalidRequest.

function parseEnrollment(body: unknown) {
  const fields = fieldsOf(body, ["studentPersonId", "reason"]);
  const studentPersonId = fields["studentPersonId"];
  if (typeof studentPersonId !== "string" || studentPersonId.length === 0) {
    throw new InvalidRequest("studentPersonId must name a Person");
  }
  return { studentPersonId, reason: reasonFrom(fields["reason"]) };
}

/** An Enrollment does not end without a reason, and ending takes nothing else. */
function parseEnding(body: unknown): string {
  const reason = reasonFrom(fieldsOf(body ?? {}, ["reason"])["reason"]);
  if (reason === null) {
    throw new InvalidRequest("reason is required");
  }
  return reason;
}

/**
 * The Enrollment the actor may end, locked for the rest of the transaction. The
 * decision comes first and the lock second: see lockEnrollment.
 */
async function lockPermitted(
  transaction: Queryable,
  actor: Actor,
  enrollmentId: string,
): Promise<Enrollment> {
  const permitted = authorizeManageEnrollment(
    actor,
    enrollmentId,
    await findEnrollment(transaction, enrollmentId),
  );
  return lockEnrollment(transaction, permitted);
}

async function recordChange(
  transaction: Queryable,
  actor: Actor,
  action: "enrollment.recorded" | "enrollment.ended",
  { before, after, reason }: { before: Enrollment | null; after: Enrollment; reason: string | null },
): Promise<void> {
  await appendAuditRecord(transaction, {
    schoolId: actor.schoolId,
    actorPersonId: actor.person.id,
    action,
    target: { type: "enrollment", id: after.id },
    reason,
    before: before === null ? null : valuesOf(before),
    after: valuesOf(after),
  });
}

/**
 * Enrollments are recorded and ended by a School Administrator of the School
 * they belong to, as memberships are: every decision is the Access module's,
 * asked before anything else about the request is looked at, and every change
 * is recorded in the transaction that makes it.
 *
 * Ending an Enrollment is departure, and departure only. It ends every Guardian
 * link to the Student, and nothing else: the Student's memberships are not
 * touched, since their narrowed access is derived from there being no open
 * Enrollment, and every record stays with the School. No route here, or
 * anywhere, sends a departing Student's records elsewhere; "transfer" is a
 * reason an Enrollment ended, not a movement of data.
 */
export function registerEnrollmentRoutes(scope: SchoolScope, database: Database): void {
  scope.get("/enrollments", async (actor) => {
    const schoolId = authorizeManageEnrollments(actor);
    return { enrollments: (await enrollmentsInSchool(database, schoolId)).map(present) };
  });

  scope.post("/enrollments", async (actor, { body }) => {
    authorizeManageEnrollments(actor);
    const request = parseEnrollment(body);
    return withTransaction(database, async (transaction) => {
      const student = authorizeEnroll(
        actor,
        request.studentPersonId,
        await findPerson(transaction, request.studentPersonId),
      );
      // Enrolling confers no role: only a Person the School holds as a Student,
      // now or from a later start, is enrolled.
      if (!(await holdsRoleNowOrLater(transaction, student, "student"))) {
        throw new InvalidRequest("studentPersonId must name a Person holding a Student membership");
      }
      const enrollment = await recordEnrollment(transaction, student);
      if (enrollment === null) {
        throw new InvalidRequest("the Student already holds an open Enrollment");
      }
      await recordChange(transaction, actor, "enrollment.recorded", {
        before: null,
        after: enrollment,
        reason: request.reason,
      });
      return { enrollment: present(enrollment) };
    });
  });

  // Ending an Enrollment rather than deleting it: the row stays as the
  // Student's history.
  scope.delete("/enrollments/:enrollmentId", async (actor, { params, body }) => {
    return withTransaction(database, async (transaction) => {
      const enrollment = await lockPermitted(transaction, actor, params["enrollmentId"]!);
      const reason = parseEnding(body);
      // Already ended: nothing is ended, so nothing is recorded.
      if (enrollment.endedAt !== null) {
        return { enrollment: present(enrollment) };
      }
      const ended = await endEnrollmentNow(transaction, enrollment.id, reason);
      const endedLinks = await endGuardianLinksTo(transaction, {
        id: ended.studentPersonId,
        schoolId: ended.schoolId,
      });
      await recordChange(transaction, actor, "enrollment.ended", { before: enrollment, after: ended, reason });
      for (const link of endedLinks) {
        // Only links in force were ended, so each was open just before.
        await recordGuardianLinkChange(transaction, actor, "guardian_link.ended", {
          before: { ...link, endedAt: null },
          after: link,
          reason,
        });
      }
      return { enrollment: present(ended) };
    });
  });
}
