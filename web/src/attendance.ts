import type { AttendanceStatus, ConflictDetail, Tally } from "./api.ts";

/** Every status, in the order a control offers them, as a reader says it. */
export const STATUS_NAMES: Record<AttendanceStatus, string> = {
  present: "Present",
  tardy: "Tardy",
  excused_absence: "Excused absence",
  unexcused_absence: "Unexcused absence",
  absent_pending_review: "Absent, pending review",
};

export const STATUSES = Object.keys(STATUS_NAMES) as AttendanceStatus[];

/** What each of a Student's Attendance totals counts, in the order they are read. */
export const TALLY_NAMES: Record<Tally, string> = { ...STATUS_NAMES, not_recorded: "Not recorded" };

export const TALLIES = Object.keys(TALLY_NAMES) as Tally[];

/** The letter a status is written with where a grid has room for one, spelled out in the grid's key. */
export const STATUS_LETTERS: Record<AttendanceStatus, string> = {
  present: "P",
  tardy: "T",
  excused_absence: "E",
  unexcused_absence: "U",
  absent_pending_review: "R",
};

/** A mark as a Correction request proposes to change it: none, where nothing was recorded. */
export function statusOrNone(status: AttendanceStatus | null): string {
  return status === null ? "Not recorded" : STATUS_NAMES[status];
}

/** Why raising or deciding a Correction request changed nothing, in the words of the rule. */
export function correctionConflictMessage(conflict: ConflictDetail): string {
  switch (conflict.conflict) {
    case "not_instructional_day":
      return "That date is not an Instructional day in the class’s Term, so it holds no Attendance.";
    case "after_today":
      return "That date has not come yet, so it holds no Attendance.";
    case "not_rostered_on_date":
      return "That Student was not on the class’s roster on that date.";
    case "enrollment_ended":
      return "That Student’s Enrollment had ended by that date.";
    case "unchanged":
      return "The Attendance already holds that status, so there is nothing to correct.";
    case "not_pending":
      return "This request has already been decided or withdrawn.";
    case "own_request":
      return "You raised this request, so another School Administrator decides it.";
    case "target_changed":
      return "The Attendance changed after this request was raised, so approving it would overwrite the newer mark. Reject it, and raise another if a change is still needed.";
    default:
      return "That change could not be made.";
  }
}
