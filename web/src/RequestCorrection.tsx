import { useState } from "react";
import { sameContent } from "../../src/results/term-results.ts";
import { MAX_REASON_LENGTH, MAX_TERM_RESULT_COMMENT_LENGTH, MAX_TERM_RESULT_SCORE } from "../../src/validation/bounds.ts";
import type { AttendanceStatus, CorrectionRaising, PublishedContent } from "./api.ts";
import { STATUS_NAMES, STATUSES, statusOrNone } from "./attendance.ts";
import { contentText } from "./corrections.ts";
import { ConfirmDialog } from "./Dialog.tsx";
import { formatSchoolDate } from "./standing.ts";

/** What a Correction request for one Student's Attendance, or their Term result, proposes. */
export type Raising = CorrectionRaising;

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
          onRequest({ kind: "attendance", classOfferingId, studentPersonId: student.id, date, after, reason });
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
      <ReasonField reason={reason} onChange={setReason} />
    </ConfirmDialog>
  );
}

/**
 * Asks what a Student's published Term result should say, its value, score
 * and comment, each starting as it stands, and why, before a Correction
 * request is raised for it. A new value comes from the current scale; a value
 * an older version gave stays offered as it is. Nothing changes until a School
 * Administrator approves it; cancelling sends nothing.
 */
export function RequestResultCorrection({
  classOfferingId,
  student,
  current,
  values,
  busy,
  onCancel,
  onRequest,
}: {
  classOfferingId: string;
  student: { id: string; displayName: string };
  /** The published result as the page read it. */
  current: PublishedContent;
  /** The current scale's labels, in order. */
  values: string[];
  busy: boolean;
  onCancel: () => void;
  onRequest: (raising: Raising) => void;
}) {
  const [value, setValue] = useState(current.value);
  const [score, setScore] = useState(current.score === null ? "" : String(current.score));
  const [comment, setComment] = useState(current.comment ?? "");
  const [reason, setReason] = useState("");
  const after: PublishedContent = {
    value,
    score: score.trim() === "" ? null : Number(score),
    comment: comment.trim() === "" ? null : comment,
  };
  const unchanged = sameContent(after, current);

  return (
    <ConfirmDialog
      title={`Request a correction for ${student.displayName}?`}
      confirm="Request the correction"
      busy={busy || unchanged || reason.trim() === ""}
      onCancel={onCancel}
      onConfirm={() => onRequest({ kind: "term_result", classOfferingId, studentPersonId: student.id, after, reason })}
    >
      <p>
        {student.displayName}’s published result is {contentText(current)}. A School
        Administrator approves or rejects the change; it is made only once approved.
      </p>
      <label>
        Value
        <select name="value" required value={value} onChange={(event) => setValue(event.currentTarget.value)}>
          {!values.includes(current.value) && <option value={current.value}>{current.value} (an earlier scale)</option>}
          {values.map((label) => (
            <option key={label} value={label}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Score, 0 to {MAX_TERM_RESULT_SCORE}, or blank for none
        <input
          name="score"
          type="number"
          inputMode="decimal"
          min={0}
          max={MAX_TERM_RESULT_SCORE}
          step={0.1}
          value={score}
          onChange={(event) => setScore(event.currentTarget.value)}
        />
      </label>
      <label>
        Comment, or blank for none
        <textarea
          name="comment"
          rows={2}
          maxLength={MAX_TERM_RESULT_COMMENT_LENGTH}
          value={comment}
          onChange={(event) => setComment(event.currentTarget.value)}
        />
      </label>
      <ReasonField reason={reason} onChange={setReason} />
    </ConfirmDialog>
  );
}

function ReasonField({ reason, onChange }: { reason: string; onChange: (reason: string) => void }) {
  return (
    <label>
      Reason
      <input
        name="reason"
        required
        maxLength={MAX_REASON_LENGTH}
        autoComplete="off"
        value={reason}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}
