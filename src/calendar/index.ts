import type { Queryable } from "../db/transaction.ts";

/**
 * The School calendar: the one place an instant becomes a School date, and
 * the one place a School date is found to be an Instructional day or not.
 *
 * A School date is a calendar date as observed in the School's timezone
 * (CONTEXT.md: School date), written `YYYY-MM-DD`. Working one out means
 * knowing the School's timezone, its daylight-saving rules, and where its
 * midnight falls in UTC, and all of that stays in here. Everything else asks
 * this module a question and gets a date back, never an offset to apply.
 *
 * The arithmetic is the database's, and every School's timezone is one of the
 * names the database itself knows (migrations/0012), so a timezone a School
 * can have is always one this module can interpret.
 *
 * Like the Identity module, it decides nothing about who may ask.
 */

/** A calendar date as observed in one School's timezone, as `YYYY-MM-DD`. */
export type SchoolDate = string;

/** The days of the week, Monday first, as an Academic Year's weekday pattern names them. */
export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

export type Weekday = (typeof WEEKDAYS)[number];

/**
 * The School date this instant falls on in the School's timezone, or null when
 * there is no such School.
 */
export async function schoolDateAt(
  database: Queryable,
  { schoolId, at }: { schoolId: string; at: Date },
): Promise<SchoolDate | null> {
  const { rows } = await database.query<{ schoolDate: SchoolDate }>(
    `SELECT to_char(($2::timestamptz AT TIME ZONE timezone)::date, 'YYYY-MM-DD') AS "schoolDate"
     FROM app.school
     WHERE id = $1`,
    [schoolId, at],
  );
  return rows[0]?.schoolDate ?? null;
}

/**
 * Whether this School date is an Instructional day: one that falls in one of
 * the School's Academic Years, and is either on a weekday of that year's
 * pattern and not taken out, or put in (CONTEXT.md: Instructional day). A date
 * in no Academic Year is not one.
 */
export async function isInstructionalDay(
  database: Queryable,
  { schoolId, date }: { schoolId: string; date: SchoolDate },
): Promise<boolean> {
  const { rows } = await database.query<{ instructional: boolean }>(
    // Only the year holding the date is stepped through, and only to that date.
    `SELECT EXISTS (
       ${INSTRUCTIONAL_DAYS}
         AND $2::date BETWEEN academic_year.first_date AND academic_year.last_date
         AND days.day = $2::date
     ) AS instructional`,
    [schoolId, date],
  );
  return rows[0]!.instructional;
}

/** Each of a School's Academic Years' Instructional days in order, by the year's identifier. */
export async function instructionalDaysInSchool(
  database: Queryable,
  schoolId: string,
): Promise<Map<string, SchoolDate[]>> {
  const { rows } = await database.query<{ academicYearId: string; date: SchoolDate }>(
    `${INSTRUCTIONAL_DAYS} ORDER BY days.day`,
    [schoolId],
  );
  const byYear = new Map<string, SchoolDate[]>();
  for (const { academicYearId, date } of rows) {
    byYear.set(academicYearId, [...(byYear.get(academicYearId) ?? []), date]);
  }
  return byYear;
}

/**
 * Every Instructional day of School `$1`'s Academic Years, as the rule makes
 * them: each School date in a year, in by its weekday unless an exception on
 * it says otherwise. Written once, so the two questions above cannot come to
 * disagree.
 *
 * A School date is a date and nothing more: stepping through a year a day at
 * a time never meets a clock change, since no timezone is involved.
 */
const INSTRUCTIONAL_DAYS = `
  SELECT academic_year.id AS "academicYearId", to_char(days.day, 'YYYY-MM-DD') AS date
  FROM app.academic_year
  CROSS JOIN LATERAL generate_series(academic_year.first_date, academic_year.last_date, interval '1 day') AS days (day)
  LEFT JOIN app.instructional_day_exception AS exception
    ON exception.school_id = academic_year.school_id
   AND exception.academic_year_id = academic_year.id
   AND exception.date = days.day::date
  WHERE academic_year.school_id = $1
    AND coalesce(exception.instructional, extract(isodow FROM days.day)::smallint = ANY (academic_year.weekdays))`;

/**
 * Whether this is an IANA timezone identifier the database knows, spelt
 * exactly as it spells it: the only timezones a School may have.
 */
export async function isKnownTimezone(database: Queryable, name: string): Promise<boolean> {
  const { rows } = await database.query<{ known: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM app.timezone WHERE name = $1) AS known`,
    [name],
  );
  return rows[0]!.known;
}

/**
 * The timezones worth offering someone choosing one, in order: every
 * `Area/Location` identifier, and UTC.
 *
 * Narrower than what a School may have. The database also knows legacy
 * aliases (`US/Eastern`) and bare rules (`EST5EDT`), which a School keeps if
 * it was given one but which nobody choosing afresh needs to scroll past.
 */
export async function offeredTimezones(database: Queryable): Promise<string[]> {
  const { rows } = await database.query<{ name: string }>(
    `SELECT name
     FROM app.timezone
     WHERE name ~ '^(Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)/'
        OR name = 'UTC'
     ORDER BY name COLLATE "C"`,
  );
  return rows.map((row) => row.name);
}
