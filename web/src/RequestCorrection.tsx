import { useState } from "react";
import { MAX_REASON_LENGTH } from "../../src/validation/bounds.ts";
import type { AttendanceStatus } from "./api.ts";
import { STATUS_NAMES, STATUSES, statusOrNone } from "./attendance.ts";
import { ConfirmDialog } from "./Dialog.tsx";
import { formatSchoolDate } from "./standing.ts";

/** What a Correction request for one Student's Attendance proposes. */
export interface Raising {
  classOfferingId: string;
  studentPersonId: string;
  date: string;
  after: AttendanceStatus;
  reason: string;
}

/**
 * Asks for the status a Student's Attendance on one date should hold, and
 * why, before a Correction request is raised for it. Nothing changes until a
 * School Administrator approves it, which the dialog says; cancelling sends
 * nothing.
 */
export function RequestCorrection({
  classOfferingId,
  date,
  student,
  current,
  busy,
  onCancel,
  onRequest,
}: {
  classOfferingId: string;
  date: string;
  student: { id: string; displayName: string };
  /** The Student's mark as the page read it; null where none is recorded. */
  current: AttendanceStatus | null;
  busy: boolean;
  onCancel: () => void;
  onRequest: (raising: Raising) => void;
}) {
  const [after, setAfter] = useState<AttendanceStatus | "">("");
  const [reason, setReason] = useState("");

  return (
    <ConfirmDialog
      title={`Request a correction for ${student.displayName}?`}
      confirm="Request the correction"
      busy={busy || after === "" || reason.trim() === ""}
      onCancel={onCancel}
      onConfirm={() => {
        if (after !== "") {
          onRequest({ classOfferingId, studentPersonId: student.id, date, after, reason });
        }
      }}
    >
      <p>
        {student.displayName}’s Attendance on {formatSchoolDate(date)} is {statusOrNone(current)}. A School
        Administrator approves or rejects the change; it is made only once approved.
      </p>
      <label>
        Correct it to
        <select name="after" required value={after} onChange={(event) => setAfter(event.currentTarget.value as AttendanceStatus)}>
          <option value="" disabled>
            Choose a status
          </option>
          {STATUSES.filter((status) => status !== current).map((status) => (
            <option key={status} value={status}>
              {STATUS_NAMES[status]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Reason
        <input
          name="reason"
          required
          maxLength={MAX_REASON_LENGTH}
          autoComplete="off"
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value)}
        />
      </label>
    </ConfirmDialog>
  );
}
