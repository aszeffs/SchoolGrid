import type { FastifyInstance } from "fastify";
import {
  approverStanding,
  authorizeDecideCorrectionRequest,
  authorizeRaiseCorrectionRequest,
  authorizeReadAttendanceOf,
  authorizeReadCorrectionRequest,
  authorizeReadCorrectionRequests,
  authorizeWithdrawCorrectionRequest,
  type Actor,
} from "../access/index.ts";
import { presentOffering } from "../academic-structure/course-routes.ts";
import { classOfferingsInSchool, findClassOffering, type DescribedClassOffering } from "../academic-structure/courses.ts";
import { appendAuditRecord, type AuditValues } from "../audit/index.ts";
import type { Authenticator } from "../authentication/index.ts";
import { schoolDateAt, type SchoolDate } from "../calendar/index.ts";
import type { Database } from "../db/pool.ts";
import { transactionTime, withTransaction, type Queryable } from "../db/transaction.ts";
import { Conflict } from "../http/conflict.ts";
import { InvalidRequest } from "../http/invalid-request.ts";
import { fieldsOf, reasonFrom, schoolDateFrom } from "../http/request-body.ts";
import { registerSchoolScope } from "../http/school-scope.ts";
import { findPersons } from "../identity/index.ts";
import {
  applyCorrection,
  correctionRequestsIn,
  decideCorrectionRequest,
  findCorrectionRequest,
  lockCorrectionRequest,
  lockTarget,
  raiseCorrectionRequest,
  type AttendanceTarget,
  type CorrectionRequest,
} from "./correction-requests.ts";
import { recordChange } from "./routes.ts";
import { ATTENDANCE_STATUSES, dateProblem, isAttendanceStatus, studentProblem, type AttendanceStatus } from "./sessions.ts";

const RAISE_FIELDS = ["kind", "studentPersonId", "date", "after", "reason"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Validation below runs only once the Access decision has permitted the
// caller: see InvalidRequest.

function parseRaise(body: unknown): { studentPersonId: string; date: SchoolDate; after: AttendanceStatus; reason: string } {
  const fields = fieldsOf(body, RAISE_FIELDS);
  if (fields["kind"] !== "attendance") {
    throw new InvalidRequest("kind must be attendance");
  }
  const studentPersonId = fields["studentPersonId"];
  if (typeof studentPersonId !== "string" || !UUID.test(studentPersonId)) {
    throw new InvalidRequest("studentPersonId must name a Student");
  }
  const date = schoolDateFrom(fields["date"], "date");
  const after = fields["after"];
  if (!isAttendanceStatus(after)) {
    throw new InvalidRequest(`after must be one of ${ATTENDANCE_STATUSES.join(", ")}`);
  }
  return { studentPersonId, date, after, reason: requiredReason(reasonFrom(fields["reason"])) };
}

/**
 * Where a request is taken: Approved, Rejected with a reason, which nothing
 * else carries, or Withdrawn.
 */
function parseDecision(body: unknown): { state: "approved" } | { state: "withdrawn" } | { state: "rejected"; reason: string } {
  const fields = fieldsOf(body, ["state", "reason"]);
  const state = fields["state"];
  if (state === "rejected") {
    return { state, reason: requiredReason(reasonFrom(fields["reason"])) };
  }
  if (state !== "approved" && state !== "withdrawn") {
    throw new InvalidRequest("state must be one of approved, rejected, withdrawn");
  }
  if (fields["reason"] !== undefined) {
    throw new InvalidRequest("only a rejection carries a reason");
  }
  return { state };
}

function requiredReason(reason: string | null): string {
  if (reason === null || reason.trim().length === 0) {
    throw new InvalidRequest("reason must be given");
  }
  return reason;
}

/**
 * Refuses a target that could have no Attendance: the recording rule's date
 * and roster conditions, all but the window, which a Correction request is
 * not bound by (CONTEXT.md: Correction request).
 */
async function checkTarget(database: Queryable, offering: DescribedClassOffering, target: AttendanceTarget): Promise<void> {
  const today = (await schoolDateAt(database, { schoolId: offering.schoolId, at: await transactionTime(database) }))!;
  const problem =
    (await dateProblem(database, { schoolId: offering.schoolId, term: offering.term, date: target.date, today, attendanceWindow: null })) ??
    (await studentProblem(database, target));
  if (problem !== null) {
    throw new Conflict({ conflict: problem });
  }
}

/** A request as written to the Audit record: its target, values, and state. */
function valuesOf(request: CorrectionRequest): AuditValues {
  return {
    kind: request.kind,
    studentPersonId: request.studentPersonId,
    classOfferingId: request.classOfferingId,
    date: request.date,
    beforeValue: request.before,
    afterValue: request.after,
    state: request.state,
    selfApproved: request.selfApproved,
  };
}

async function recordTransition(
  transaction: Queryable,
  actor: Actor,
  verb: "raised" | "approved" | "rejected" | "withdrawn",
  before: CorrectionRequest | null,
  after: CorrectionRequest,
  reason: string | null,
): Promise<void> {
  await appendAuditRecord(transaction, {
    schoolId: actor.schoolId,
    actorPersonId: actor.person.id,
    action: `correction_request.${verb}`,
    target: { type: "correction_request", id: after.id },
    reason,
    before: before === null ? null : valuesOf(before),
    after: valuesOf(after),
  });
}

/** Requests as their readers are served them: each Person named by display name, and each Class Offering described. */
async function serveRequests(database: Queryable, schoolId: string, requests: readonly CorrectionRequest[]) {
  const persons = await findPersons(
    database,
    requests.flatMap((request) => [
      request.studentPersonId,
      request.requestedByPersonId,
      ...(request.decidedByPersonId === null ? [] : [request.decidedByPersonId]),
    ]),
  );
  const named = (id: string) => ({ id, displayName: persons.get(id)?.displayName ?? "" });
  const offerings = new Map((await classOfferingsInSchool(database, schoolId)).map((offering) => [offering.id, offering]));
  return requests.map((request) => ({
    id: request.id,
    kind: request.kind,
    state: request.state,
    student: named(request.studentPersonId),
    // Nothing deletes a Class Offering a request names while its roster stands.
    classOffering: presentOffering(offerings.get(request.classOfferingId)!),
    date: request.date,
    before: request.before,
    after: request.after,
    reason: request.reason,
    requestedBy: named(request.requestedByPersonId),
    raisedAt: request.raisedAt.toISOString(),
    decidedBy: request.decidedByPersonId === null ? null : named(request.decidedByPersonId),
    decidedAt: request.decidedAt?.toISOString() ?? null,
    rejectionReason: request.rejectionReason,
    selfApproved: request.selfApproved,
  }));
}

async function serveRequest(database: Queryable, request: CorrectionRequest) {
  return { correctionRequest: (await serveRequests(database, request.schoolId, [request]))[0]! };
}

/**
 * Correction requests for Attendance (CONTEXT.md: Correction request): a
 * proposed change to one Student's Attendance in one Class Offering on one
 * School date, with a reason, raised at any time.
 *
 * Raised by a Faculty member currently teaching the offering or any School
 * Administrator; approved or rejected, with a reason, by a School
 * Administrator other than the requester, unless the School has only the one;
 * withdrawn by its requester alone; and each only while Pending, the one
 * change a request takes. Approval
 * applies the change in the same transaction, and is refused once the target
 * no longer holds the request's before value. Read by School Administrators,
 * every one, and by any other requester, their own. Every decision on who may
 * is the Access module's, asked before anything else about the request is
 * looked at.
 */
export function registerCorrectionRequestRoutes(app: FastifyInstance, database: Database, authenticator: Authenticator): void {
  registerSchoolScope(app, database, authenticator, (scope) => {
    // Pending first, oldest first, then the rest, most recently decided first.
    scope.get("/correction-requests", async (actor) => {
      const whose = authorizeReadCorrectionRequests(actor);
      return { correctionRequests: await serveRequests(database, actor.schoolId, await correctionRequestsIn(database, whose)) };
    });

    // Raises a request for one Student's Attendance in the offering, its
    // before value the target's as it stands: none, when nothing was recorded.
    scope.post("/class-offerings/:classOfferingId/correction-requests", async (actor, { params, body }) => {
      const classOfferingId = params["classOfferingId"]!;
      const readable = authorizeReadAttendanceOf(actor, classOfferingId, await findClassOffering(database, classOfferingId));
      return withTransaction(database, async (transaction) => {
        const offering = await authorizeRaiseCorrectionRequest(transaction, actor, readable);
        const { studentPersonId, date, after, reason } = parseRaise(body);
        const target = { schoolId: offering.schoolId, classOfferingId: offering.id, studentPersonId, date };
        await checkTarget(transaction, offering, target);
        const before = (await lockTarget(transaction, target))?.status ?? null;
        if (before === after) {
          throw new Conflict({ conflict: "unchanged" });
        }
        const raised = await raiseCorrectionRequest(transaction, {
          ...target,
          before,
          after,
          reason,
          requestedByPersonId: actor.person.id,
        });
        await recordTransition(transaction, actor, "raised", null, raised, reason);
        return serveRequest(transaction, raised);
      });
    });

    // Takes a Pending request to Approved, Rejected with a reason, or
    // Withdrawn. Approval applies the change in the same transaction.
    scope.patch("/correction-requests/:correctionRequestId", async (actor, { params, body }) =>
      withTransaction(database, async (transaction) => {
        const correctionRequestId = params["correctionRequestId"]!;
        const readable = authorizeReadCorrectionRequest(
          actor,
          correctionRequestId,
          await findCorrectionRequest(transaction, correctionRequestId),
        );
        const decision = parseDecision(body);
        const permitted =
          decision.state === "withdrawn"
            ? authorizeWithdrawCorrectionRequest(actor, correctionRequestId, readable)
            : authorizeDecideCorrectionRequest(actor, correctionRequestId, readable);
        const request = await lockCorrectionRequest(transaction, permitted);
        if (request.state !== "pending") {
          throw new Conflict({ conflict: "not_pending" });
        }
        const standing = await approverStanding(transaction, actor, request);
        if (decision.state !== "withdrawn" && standing === "own_request") {
          throw new Conflict({ conflict: "own_request" });
        }
        const decided = { decidedByPersonId: actor.person.id };
        switch (decision.state) {
          case "approved": {
            // The offering stands while the roster naming its Student does.
            const offering = (await findClassOffering(transaction, request.classOfferingId))!;
            await checkTarget(transaction, offering, request);
            const applied = await applyCorrection(transaction, request, { recordedByPersonId: actor.person.id });
            if (applied === null) {
              throw new Conflict({ conflict: "target_changed" });
            }
            const approved = await decideCorrectionRequest(transaction, request, {
              state: decision.state,
              ...decided,
              selfApproved: standing === "sole_administrator",
            });
            await recordTransition(transaction, actor, "approved", request, approved, null);
            if (applied.before !== null) {
              await recordChange(transaction, actor, applied.before, applied.after, request.reason);
            }
            return serveRequest(transaction, approved);
          }
          case "rejected": {
            const { state, reason } = decision;
            const rejected = await decideCorrectionRequest(transaction, request, { state, ...decided, rejectionReason: reason });
            await recordTransition(transaction, actor, "rejected", request, rejected, reason);
            return serveRequest(transaction, rejected);
          }
          case "withdrawn": {
            const withdrawn = await decideCorrectionRequest(transaction, request, { state: decision.state, ...decided });
            await recordTransition(transaction, actor, "withdrawn", request, withdrawn, null);
            return serveRequest(transaction, withdrawn);
          }
        }
      }),
    );
  });
}
