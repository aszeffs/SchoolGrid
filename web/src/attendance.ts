import type { AttendanceStatus, Tally } from "./api.ts";

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
