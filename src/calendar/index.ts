import type { Queryable } from "../db/transaction.ts";

/**
 * The School calendar: the one place an instant becomes a School date.
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
