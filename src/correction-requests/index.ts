import type { SchoolDate } from "../calendar/index.ts";
import type { Queryable } from "../db/transaction.ts";
import {
  changeAttendance,
  holdAttendanceOn,
  lockAttendanceOf,
  recordAttendance,
  type Attendance,
  type AttendanceStatus,
  type AttendanceTarget,
} from "../attendance/sessions.ts";
import {
  changeTermResult,
  currentResultValueIds,
  holdTermResults,
  sameContent,
  type TermResult,
  type TermResultContent,
} from "../results/term-results.ts";

export type { AttendanceTarget };

/**
 * Correction requests (migrations/0023, 0027; CONTEXT.md: Correction request),
 * stored with their invariants held: a proposed change to a record, Pending
 * until it is Approved, Rejected with a reason, or Withdrawn by its requester.
 *
 * A request names its kind of target: one Student's Attendance in a Class
 * Offering on one School date, or one Student's published Term result in a
 * Class Offering. Its states, and who decided it when, do not depend on the
 * kind; what it proposes, the stale-before check, and how approval applies
 * the change do.
 *
 * Like the Attendance and Results modules, it decides nothing about who may
 * act: who may raise, approve, reject or withdraw one is the Access module's.
 */

export type CorrectionRequestState = "pending" | "approved" | "rejected" | "withdrawn";

/** The kinds of record a Correction request can change. */
export type CorrectionTargetKind = "attendance" | "term_result";

/** What a published Term result says: always a value, and a score and comment each possibly null. */
export interface PublishedContent extends TermResultContent {
  value: string;
}

/** What every request holds, whatever its kind. */
interface RequestCommon {
  id: string;
  schoolId: string;
  studentPersonId: string;
  classOfferingId: string;
  reason: string;
  requestedByPersonId: string;
  raisedAt: Date;
  state: CorrectionRequestState;
  /** Who approved or rejected it, or withdrew it; null while it is Pending. */
  decidedByPersonId: string | null;
  decidedAt: Date | null;
  rejectionReason: string | null;
  /** Approved by its own requester, as the School's only School Administrator. */
  selfApproved: boolean;
}

export interface AttendanceCorrectionRequest extends RequestCommon, AttendanceTarget {
  kind: "attendance";
  /** The target's value when the request was raised; null when none was recorded. */
  before: AttendanceStatus | null;
  after: AttendanceStatus;
}

export interface TermResultCorrectionRequest extends RequestCommon {
  kind: "term_result";
  /** The published result's content when the request was raised. */
  before: PublishedContent;
  after: PublishedContent;
}

export type CorrectionRequest = AttendanceCorrectionRequest | TermResultCorrectionRequest;

/** A request as stored, before its kind shapes it. */
interface Row extends RequestCommon {
  kind: CorrectionTargetKind;
  date: SchoolDate | null;
  beforeValue: string | null;
  afterValue: string;
  beforeScore: number | null;
  afterScore: number | null;
  beforeComment: string | null;
  afterComment: string | null;
}

const REQUEST_COLUMNS = `id, school_id AS "schoolId", target_kind AS kind, student_person_id AS "studentPersonId",
  class_offering_id AS "classOfferingId", to_char(date, 'YYYY-MM-DD') AS date,
  before_value AS "beforeValue", after_value AS "afterValue", before_score::float8 AS "beforeScore",
  after_score::float8 AS "afterScore", before_comment AS "beforeComment", after_comment AS "afterComment",
  reason, requested_by_person_id AS "requestedByPersonId",
  raised_at AS "raisedAt", state, decided_by_person_id AS "decidedByPersonId", decided_at AS "decidedAt",
  rejection_reason AS "rejectionReason", self_approved AS "selfApproved"`;

function requestFrom({
  kind,
  date,
  beforeValue,
  afterValue,
  beforeScore,
  afterScore,
  beforeComment,
  afterComment,
  ...common
}: Row): CorrectionRequest {
  // The table's checks hold each kind to its own shape (migrations/0027).
  return kind === "attendance"
    ? {
        ...common,
        kind,
        date: date!,
        before: beforeValue as AttendanceStatus | null,
        after: afterValue as AttendanceStatus,
      }
    : {
        ...common,
        kind,
        before: { value: beforeValue!, score: beforeScore, comment: beforeComment },
        after: { value: afterValue, score: afterScore, comment: afterComment },
      };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The value an Attendance target holds now, and holds until the transaction ends: its Attendance, or null for none. */
export async function lockTarget(transaction: Queryable, target: AttendanceTarget): Promise<Attendance | null> {
  // Held first, so a first mark cannot land between reading none and adding one.
  await holdAttendanceOn(transaction, target);
  return lockAttendanceOf(transaction, target);
}

/**
 * One Student's Term result in a Class Offering as it stands now, or null for
 * none, held until the transaction ends with the rest of the offering's, so no
 * save or Publication lands between reading it and acting on it.
 */
export async function lockResultTarget(
  transaction: Queryable,
  target: { schoolId: string; classOfferingId: string; studentPersonId: string },
): Promise<TermResult | null> {
  const results = await holdTermResults(transaction, target);
  return results.find((result) => result.studentPersonId === target.studentPersonId) ?? null;
}

/** What raising a request stores: its target, before and after, and who raised it why. */
export type Raising = (
  | (AttendanceTarget & { kind: "attendance"; before: AttendanceStatus | null; after: AttendanceStatus })
  | {
      kind: "term_result";
      schoolId: string;
      classOfferingId: string;
      studentPersonId: string;
      before: PublishedContent;
      after: PublishedContent;
    }
) & { reason: string; requestedByPersonId: string };

/** Raises a Pending request, its before value read from the target as it now stands. */
export async function raiseCorrectionRequest(transaction: Queryable, request: Raising): Promise<CorrectionRequest> {
  const values =
    request.kind === "attendance"
      ? { date: request.date, before: { value: request.before, score: null, comment: null }, after: { value: request.after, score: null, comment: null } }
      : { date: null, before: request.before, after: request.after };
  const { rows } = await transaction.query<Row>(
    `INSERT INTO app.correction_request
       (school_id, target_kind, student_person_id, class_offering_id, date, before_value, after_value,
        before_score, after_score, before_comment, after_comment, reason, requested_by_person_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING ${REQUEST_COLUMNS}`,
    [
      request.schoolId,
      request.kind,
      request.studentPersonId,
      request.classOfferingId,
      values.date,
      values.before.value,
      values.after.value,
      values.before.score,
      values.after.score,
      values.before.comment,
      values.after.comment,
      request.reason,
      request.requestedByPersonId,
    ],
  );
  return requestFrom(rows[0]!);
}

/** The request with this identifier, in whichever School holds it, or null. */
export async function findCorrectionRequest(database: Queryable, id: string): Promise<CorrectionRequest | null> {
  if (!UUID.test(id)) {
    return null;
  }
  const { rows } = await database.query<Row>(`SELECT ${REQUEST_COLUMNS} FROM app.correction_request WHERE id = $1`, [id]);
  return rows[0] === undefined ? null : requestFrom(rows[0]);
}

/**
 * Locks a request until the transaction ends, and returns it as it now
 * stands. Only for a request the caller has already been permitted to decide.
 */
export async function lockCorrectionRequest(transaction: Queryable, request: CorrectionRequest): Promise<CorrectionRequest> {
  const { rows } = await transaction.query<Row>(
    `SELECT ${REQUEST_COLUMNS} FROM app.correction_request WHERE school_id = $1 AND id = $2 FOR UPDATE`,
    [request.schoolId, request.id],
  );
  // Nothing deletes a request but the deletion of its whole School.
  return requestFrom(rows[0]!);
}

/**
 * A School's requests, one requester's alone given `requestedByPersonId`:
 * Pending first, oldest first, then the rest, most recently decided first.
 */
export async function correctionRequestsIn(
  database: Queryable,
  { schoolId, requestedByPersonId = null }: { schoolId: string; requestedByPersonId?: string | null },
): Promise<CorrectionRequest[]> {
  const { rows } = await database.query<Row>(
    `SELECT ${REQUEST_COLUMNS} FROM app.correction_request
     WHERE school_id = $1 AND ($2::uuid IS NULL OR requested_by_person_id = $2)
     ORDER BY state <> 'pending', CASE WHEN state = 'pending' THEN raised_at END, decided_at DESC, id`,
    [schoolId, requestedByPersonId],
  );
  return rows.map(requestFrom);
}

/** Takes a locked Pending request out of Pending, naming who decided it, and now as when. */
export async function decideCorrectionRequest<R extends CorrectionRequest>(
  transaction: Queryable,
  request: R,
  {
    state,
    decidedByPersonId,
    rejectionReason = null,
    selfApproved = false,
  }: {
    state: Exclude<CorrectionRequestState, "pending">;
    decidedByPersonId: string;
    rejectionReason?: string | null;
    selfApproved?: boolean;
  },
): Promise<R> {
  const { rows } = await transaction.query<Row>(
    `UPDATE app.correction_request
     SET state = $3, decided_by_person_id = $4, decided_at = now(), rejection_reason = $5, self_approved = $6
     WHERE school_id = $1 AND id = $2 AND state = 'pending'
     RETURNING ${REQUEST_COLUMNS}`,
    [request.schoolId, request.id, state, decidedByPersonId, rejectionReason, selfApproved],
  );
  return requestFrom(rows[0]!) as R;
}

/**
 * Applies a request's after value to its Attendance, as recorded by the
 * approver, once the target still holds the request's before value. Returns
 * the target before and after, or null, changing nothing, when it has changed
 * since the request was raised. Compared by value: a mark changed and changed
 * back reads as unchanged.
 */
export async function applyCorrection(
  transaction: Queryable,
  request: AttendanceCorrectionRequest,
  { recordedByPersonId }: { recordedByPersonId: string },
): Promise<{ before: Attendance | null; after: Attendance } | null> {
  const current = await lockTarget(transaction, request);
  if ((current?.status ?? null) !== request.before) {
    return null;
  }
  const status = request.after;
  const after =
    current === null
      ? await recordAttendance(transaction, {
          schoolId: request.schoolId,
          studentPersonId: request.studentPersonId,
          classOfferingId: request.classOfferingId,
          date: request.date,
          status,
          recordedByPersonId,
        })
      : await changeAttendance(transaction, current, { status, recordedByPersonId });
  return { before: current, after };
}

/**
 * Applies a request's after content to its published Term result, as recorded
 * by the approver, once the result still says all of what the request's before
 * content does. A changed value is bound to the current scale version, and one
 * the current scale no longer holds is refused; a value left as it was keeps
 * its version. Returns the result before and after, or why nothing changed.
 * Compared by content, as a draft save is.
 */
export async function applyResultCorrection(
  transaction: Queryable,
  request: TermResultCorrectionRequest,
  { recordedByPersonId }: { recordedByPersonId: string },
): Promise<{ before: TermResult; after: TermResult } | "target_changed" | "value_not_in_scale"> {
  const current = await lockResultTarget(transaction, request);
  // Nothing removes a published result, nor unpublishes it.
  if (!sameContent(current!, request.before)) {
    return "target_changed";
  }
  const { value, score, comment } = request.after;
  let resultValueId = current!.resultValueId;
  if (value !== current!.value) {
    const bound = (await currentResultValueIds(transaction, request.schoolId)).get(value);
    if (bound === undefined) {
      return "value_not_in_scale";
    }
    resultValueId = bound;
  }
  const after = await changeTermResult(transaction, current!, { resultValueId, score, comment, recordedByPersonId });
  return { before: current!, after };
}
