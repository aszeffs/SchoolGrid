import type { FastifyInstance } from "fastify";
import {
  approverStanding,
  authorizeDecideCorrectionRequest,
  authorizeRaiseCorrectionRequest,
  authorizeReadAttendanceOf,
  authorizeReadCorrectionRequest,
  authorizeReadCorrectionRequests,
  authorizeReadTermResultsOf,
  authorizeWithdrawCorrectionRequest,
  type Actor,
} from "../access/index.ts";
import { presentOffering } from "../academic-structure/course-routes.ts";
import { classOfferingsInSchool, findClassOffering, type DescribedClassOffering } from "../academic-structure/courses.ts";
import { recordChange } from "../attendance/routes.ts";
import { ATTENDANCE_STATUSES, dateProblem, isAttendanceStatus, studentProblem, type AttendanceStatus } from "../attendance/sessions.ts";
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
import { recordResultChange, termResultContentFrom } from "../results/term-result-routes.ts";
import { currentResultValueIds, sameContent } from "../results/term-results.ts";
import {
  applyAttendanceCorrection,
  applyResultCorrection,
  correctionRequestsIn,
  decideCorrectionRequest,
  findCorrectionRequest,
  lockCorrectionRequest,
  lockResultTarget,
  lockAttendanceTarget,
  raiseCorrectionRequest,
  type AttendanceCorrectionRequest,
  type AttendanceTarget,
  type CorrectionRequest,
  type PublishedContent,
  type TermResultCorrectionRequest,
} from "./index.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Validation below runs only once the Access decision has permitted the
// caller: see InvalidRequest.

/**
 * Which kind of target a body names, read on its own and leniently: which
 * records the caller must be permitted to read depends on it, so it is read
 * before the rest of the body, and anything else is taken for Attendance.
 * Both kinds are read by the same actors, so the answer never tells a caller
 * more than the other would.
 */
function raisingKind(body: unknown): "attendance" | "term_result" {
  return typeof body === "object" && body !== null && (body as Record<string, unknown>)["kind"] === "term_result"
    ? "term_result"
    : "attendance";
}

function studentFrom(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new InvalidRequest("studentPersonId must name a Student");
  }
  return value;
}

function parseAttendanceRaise(body: unknown): { studentPersonId: string; date: SchoolDate; after: AttendanceStatus; reason: string } {
  const fields = fieldsOf(body, ["kind", "studentPersonId", "date", "after", "reason"]);
  if (fields["kind"] !== "attendance") {
    throw new InvalidRequest("kind must be attendance or term_result");
  }
  const date = schoolDateFrom(fields["date"], "date");
  const after = fields["after"];
  if (!isAttendanceStatus(after)) {
    throw new InvalidRequest(`after must be one of ${ATTENDANCE_STATUSES.join(", ")}`);
  }
  return { studentPersonId: studentFrom(fields["studentPersonId"]), date, after, reason: requiredReason(reasonFrom(fields["reason"])) };
}

/** A Term result request: its Student, and the whole content the result should say, a value included. */
function parseResultRaise(body: unknown): { studentPersonId: string; after: PublishedContent; reason: string } {
  const fields = fieldsOf(body, ["kind", "studentPersonId", "after", "reason"]);
  const after = termResultContentFrom(fieldsOf(fields["after"], ["value", "score", "comment"]), "after's");
  if (after.value === null) {
    throw new InvalidRequest("after's value must be a label of the Result value scale: a published result keeps one");
  }
  return {
    studentPersonId: studentFrom(fields["studentPersonId"]),
    after: after as PublishedContent,
    reason: requiredReason(reasonFrom(fields["reason"])),
  };
}

/**
 * Whether a body asks to withdraw a request, read on its own and leniently:
 * who may act depends on it, so it is read before the rest of the body, and
 * anything else is decided as an approval or rejection would be.
 */
function withdrawing(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as Record<string, unknown>)["state"] === "withdrawn";
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
 * Refuses an Attendance target that could have no Attendance: the recording
 * rule's date and roster conditions, all but the window, which a Correction
 * request is not bound by (CONTEXT.md: Correction request).
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
  const target = { kind: request.kind, studentPersonId: request.studentPersonId, classOfferingId: request.classOfferingId };
  const decision = { state: request.state, selfApproved: request.selfApproved };
  return request.kind === "attendance"
    ? { ...target, date: request.date, beforeValue: request.before, afterValue: request.after, ...decision }
    : {
        ...target,
        beforeValue: request.before.value,
        beforeScore: request.before.score,
        beforeComment: request.before.comment,
        afterValue: request.after.value,
        afterScore: request.after.score,
        afterComment: request.after.comment,
        ...decision,
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

/**
 * Requests as their readers are served them: each Person named by display
 * name, and each Class Offering described. An Attendance request names its
 * date and statuses; a Term result request, the result's content before and
 * after.
 */
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
    ...(request.kind === "attendance"
      ? { date: request.date, before: request.before, after: request.after }
      : { before: request.before, after: request.after }),
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

/** Raises a request for one Student's Attendance, its before value the target's as it stands: none, when nothing was recorded. */
async function raiseForAttendance(transaction: Queryable, actor: Actor, offering: DescribedClassOffering, body: unknown) {
  const { studentPersonId, date, after, reason } = parseAttendanceRaise(body);
  const target = { schoolId: offering.schoolId, classOfferingId: offering.id, studentPersonId, date };
  await checkTarget(transaction, offering, target);
  const before = (await lockAttendanceTarget(transaction, target))?.status ?? null;
  if (before === after) {
    throw new Conflict({ conflict: "unchanged" });
  }
  return raiseCorrectionRequest(transaction, {
    kind: "attendance",
    ...target,
    before,
    after,
    reason,
    requestedByPersonId: actor.person.id,
  });
}

/**
 * Raises a request for one Student's published Term result, its before
 * content the result's as it stands. A draft, or no result, is refused: a
 * draft is changed by saving it. A new value must be on the current scale.
 */
async function raiseForTermResult(transaction: Queryable, actor: Actor, offering: DescribedClassOffering, body: unknown) {
  const { studentPersonId, after, reason } = parseResultRaise(body);
  const target = { schoolId: offering.schoolId, classOfferingId: offering.id, studentPersonId };
  const current = await lockResultTarget(transaction, target);
  if (current === null || current.publishedAt === null) {
    throw new Conflict({ conflict: "not_published" });
  }
  // A published result always carries a value.
  const before = { value: current.value!, score: current.score, comment: current.comment };
  if (sameContent(before, after)) {
    throw new Conflict({ conflict: "unchanged" });
  }
  if (after.value !== before.value && !(await currentResultValueIds(transaction, offering.schoolId)).has(after.value)) {
    throw new Conflict({ conflict: "value_not_in_scale" });
  }
  return raiseCorrectionRequest(transaction, {
    kind: "term_result",
    ...target,
    before,
    after,
    reason,
    requestedByPersonId: actor.person.id,
  });
}

/** Applies an approved Attendance request, and audits the Attendance it changed; a first mark carries its own recorder. */
async function applyAttendance(transaction: Queryable, actor: Actor, request: AttendanceCorrectionRequest): Promise<void> {
  // The offering stands while the roster naming its Student does.
  const offering = (await findClassOffering(transaction, request.classOfferingId))!;
  await checkTarget(transaction, offering, request);
  const applied = await applyAttendanceCorrection(transaction, request, { recordedByPersonId: actor.person.id });
  if (applied === null) {
    throw new Conflict({ conflict: "target_changed" });
  }
  if (applied.before !== null) {
    await recordChange(transaction, actor, applied.before, applied.after, request.reason);
  }
}

/** Applies an approved Term result request, and audits the result it changed. */
async function applyTermResult(transaction: Queryable, actor: Actor, request: TermResultCorrectionRequest): Promise<void> {
  const applied = await applyResultCorrection(transaction, request, { recordedByPersonId: actor.person.id });
  if (typeof applied === "string") {
    throw new Conflict({ conflict: applied });
  }
  await recordResultChange(transaction, actor, request.classOfferingId, applied.before, applied.after, request.reason);
}

/**
 * Correction requests (CONTEXT.md: Correction request): a proposed change,
 * with a reason, raised at any time, to one Student's Attendance in one Class
 * Offering on one School date, or to one Student's published Term result in
 * one Class Offering.
 *
 * Raised by a Faculty member currently teaching the offering or any School
 * Administrator; approved or rejected, with a reason, by a School
 * Administrator other than the requester, unless the School has only the one;
 * withdrawn by its requester alone; and each only while Pending, the one
 * change a request takes. Approval applies the change in the same
 * transaction, and is refused once the target no longer holds the request's
 * before value. Read by School Administrators, every one, and by any other
 * requester, their own. Every decision on who may is the Access module's,
 * asked before anything else about the request is looked at.
 */
export function registerCorrectionRequestRoutes(app: FastifyInstance, database: Database, authenticator: Authenticator): void {
  registerSchoolScope(app, database, authenticator, (scope) => {
    // Pending first, oldest first, then the rest, most recently decided first.
    scope.get("/correction-requests", async (actor) => {
      const whose = authorizeReadCorrectionRequests(actor);
      return { correctionRequests: await serveRequests(database, actor.schoolId, await correctionRequestsIn(database, whose)) };
    });

    // Raises a request for one Student in the offering, its before value
    // the target's as it stands.
    scope.post("/class-offerings/:classOfferingId/correction-requests", async (actor, { params, body }) => {
      const classOfferingId = params["classOfferingId"]!;
      const kind = raisingKind(body);
      const authorizeRead = kind === "term_result" ? authorizeReadTermResultsOf : authorizeReadAttendanceOf;
      const readable = authorizeRead(actor, classOfferingId, await findClassOffering(database, classOfferingId));
      return withTransaction(database, async (transaction) => {
        const offering = await authorizeRaiseCorrectionRequest(transaction, actor, readable);
        const raised =
          kind === "term_result"
            ? await raiseForTermResult(transaction, actor, offering, body)
            : await raiseForAttendance(transaction, actor, offering, body);
        await recordTransition(transaction, actor, "raised", null, raised, raised.reason);
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
        const permitted = withdrawing(body)
          ? authorizeWithdrawCorrectionRequest(actor, correctionRequestId, readable)
          : authorizeDecideCorrectionRequest(actor, correctionRequestId, readable);
        const decision = parseDecision(body);
        const request = await lockCorrectionRequest(transaction, permitted);
        if (request.state !== "pending") {
          throw new Conflict({ conflict: "not_pending" });
        }
        // Only a requester withdraws, so only an approval or rejection can be someone's own.
        const standing = decision.state === "withdrawn" ? "another" : await approverStanding(transaction, actor, request);
        if (standing === "own_request") {
          throw new Conflict({ conflict: "own_request" });
        }
        const decided = { decidedByPersonId: actor.person.id };
        switch (decision.state) {
          case "approved": {
            if (request.kind === "attendance") {
              await applyAttendance(transaction, actor, request);
            } else {
              await applyTermResult(transaction, actor, request);
            }
            const approved = await decideCorrectionRequest(transaction, request, {
              state: decision.state,
              ...decided,
              selfApproved: standing === "sole_administrator",
            });
            await recordTransition(transaction, actor, "approved", request, approved, null);
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
