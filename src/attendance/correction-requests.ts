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
} from "./sessions.ts";

export type { AttendanceTarget };

/**
 * Correction requests (migrations/0023; CONTEXT.md: Correction request),
 * stored with their invariants held: a proposed change to a record, Pending
 * until it is Approved, Rejected with a reason, or Withdrawn by its requester.
 *
 * A request names its kind of target, so Term results can reuse it later. Its
 * states, the stale-before check, and approval applying the change do not
 * depend on the kind; Attendance is the only kind so far.
 *
 * Like the rest of this module, it decides nothing about who may act: who may
 * raise, approve, reject or withdraw one is the Access module's.
 */

export type CorrectionRequestState = "pending" | "approved" | "rejected" | "withdrawn";

/** The kinds of record a Correction request can change. */
export type CorrectionTargetKind = "attendance";

export interface CorrectionRequest extends AttendanceTarget {
  id: string;
  kind: CorrectionTargetKind;
  /** The target's value when the request was raised; null when none was recorded. */
  before: AttendanceStatus | null;
  after: AttendanceStatus;
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

const REQUEST_COLUMNS = `id, school_id AS "schoolId", target_kind AS kind, student_person_id AS "studentPersonId",
  class_offering_id AS "classOfferingId", to_char(date, 'YYYY-MM-DD') AS date,
  before_value AS before, after_value AS after, reason, requested_by_person_id AS "requestedByPersonId",
  raised_at AS "raisedAt", state, decided_by_person_id AS "decidedByPersonId", decided_at AS "decidedAt",
  rejection_reason AS "rejectionReason", self_approved AS "selfApproved"`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The value the target holds now, and holds until the transaction ends: its Attendance, or null for none. */
export async function lockTarget(transaction: Queryable, target: AttendanceTarget): Promise<Attendance | null> {
  // Held first, so a first mark cannot land between reading none and adding one.
  await holdAttendanceOn(transaction, target);
  return lockAttendanceOf(transaction, target);
}

/** Raises a Pending request, its before value read from the target as it now stands. */
export async function raiseCorrectionRequest(
  transaction: Queryable,
  request: AttendanceTarget & { before: AttendanceStatus | null; after: AttendanceStatus; reason: string; requestedByPersonId: string },
): Promise<CorrectionRequest> {
  const { rows } = await transaction.query<CorrectionRequest>(
    `INSERT INTO app.correction_request
       (school_id, target_kind, student_person_id, class_offering_id, date, before_value, after_value, reason,
        requested_by_person_id)
     VALUES ($1, 'attendance', $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${REQUEST_COLUMNS}`,
    [
      request.schoolId,
      request.studentPersonId,
      request.classOfferingId,
      request.date,
      request.before,
      request.after,
      request.reason,
      request.requestedByPersonId,
    ],
  );
  return rows[0]!;
}

/** The request with this identifier, in whichever School holds it, or null. */
export async function findCorrectionRequest(database: Queryable, id: string): Promise<CorrectionRequest | null> {
  if (!UUID.test(id)) {
    return null;
  }
  const { rows } = await database.query<CorrectionRequest>(
    `SELECT ${REQUEST_COLUMNS} FROM app.correction_request WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Locks a request until the transaction ends, and returns it as it now
 * stands. Only for a request the caller has already been permitted to decide.
 */
export async function lockCorrectionRequest(transaction: Queryable, request: CorrectionRequest): Promise<CorrectionRequest> {
  const { rows } = await transaction.query<CorrectionRequest>(
    `SELECT ${REQUEST_COLUMNS} FROM app.correction_request WHERE school_id = $1 AND id = $2 FOR UPDATE`,
    [request.schoolId, request.id],
  );
  // Nothing deletes a request but the deletion of its whole School.
  return rows[0]!;
}

/**
 * A School's requests, one requester's alone given `requestedByPersonId`:
 * Pending first, oldest first, then the rest, most recently decided first.
 */
export async function correctionRequestsIn(
  database: Queryable,
  { schoolId, requestedByPersonId = null }: { schoolId: string; requestedByPersonId?: string | null },
): Promise<CorrectionRequest[]> {
  const { rows } = await database.query<CorrectionRequest>(
    `SELECT ${REQUEST_COLUMNS} FROM app.correction_request
     WHERE school_id = $1 AND ($2::uuid IS NULL OR requested_by_person_id = $2)
     ORDER BY state <> 'pending', CASE WHEN state = 'pending' THEN raised_at END, decided_at DESC, id`,
    [schoolId, requestedByPersonId],
  );
  return rows;
}

/** Takes a locked Pending request out of Pending, naming who decided it, and now as when. */
export async function decideCorrectionRequest(
  transaction: Queryable,
  request: CorrectionRequest,
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
): Promise<CorrectionRequest> {
  const { rows } = await transaction.query<CorrectionRequest>(
    `UPDATE app.correction_request
     SET state = $3, decided_by_person_id = $4, decided_at = now(), rejection_reason = $5, self_approved = $6
     WHERE school_id = $1 AND id = $2 AND state = 'pending'
     RETURNING ${REQUEST_COLUMNS}`,
    [request.schoolId, request.id, state, decidedByPersonId, rejectionReason, selfApproved],
  );
  return rows[0]!;
}

/**
 * Applies a request's after value to its target, as recorded by the approver,
 * once the target still holds the request's before value. Returns the target
 * before and after, or null, changing nothing, when it has changed since the
 * request was raised. Compared by value: a mark changed and changed back reads
 * as unchanged.
 */
export async function applyCorrection(
  transaction: Queryable,
  request: CorrectionRequest,
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
