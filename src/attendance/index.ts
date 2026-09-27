import { countInstructionalDays, schoolDatePlus, schoolDateAt } from "../calendar/index.ts";
import type { Queryable } from "../db/transaction.ts";

/**
 * Attendance: what happens in a class, one Student, Class Offering and School
 * date at a time, and the Attendance window that keeps normal corrections to
 * it recent (CONTEXT.md: Attendance, Attendance window).
 *
 * A School date's Attendance may be recorded or corrected normally while the
 * School's today is no later than that date plus the window. The current
 * setting governs every School date, so changing it opens or closes past
 * dates at once.
 *
 * Like the Academic structure module, it decides nothing about who may act.
 */

/** How many Instructional days a change of the Attendance window would open, and how many it would close. */
export interface AttendanceWindowChange {
  opens: number;
  closes: number;
}

/**
 * What changing a School's Attendance window from `from` days to `to` days
 * would do at this instant: the Instructional days up to the School's today
 * that it would open, or close. Only Instructional days are counted, since no
 * other School date can hold Attendance. A year's Terms cover all of it, so
 * Terms are left out of the count; only a year with no Term yet counts days
 * no Attendance could fall on.
 */
export async function attendanceWindowChange(
  database: Queryable,
  { schoolId, at, from, to }: { schoolId: string; at: Date; from: number; to: number },
): Promise<AttendanceWindowChange> {
  if (from === to) {
    return { opens: 0, closes: 0 };
  }
  // The caller names a School that exists.
  const today = (await schoolDateAt(database, { schoolId, at }))!;
  // A window of w days holds the School dates from w days before today up to
  // today. Two windows differ only in their oldest dates: from the longer
  // one's first date up to the day before the shorter one's.
  const changed = await countInstructionalDays(database, {
    schoolId,
    from: schoolDatePlus(today, -Math.max(from, to)),
    to: schoolDatePlus(today, -Math.min(from, to) - 1),
  });
  return to > from ? { opens: changed, closes: 0 } : { opens: 0, closes: changed };
}
