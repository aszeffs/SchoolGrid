import { WEEKDAYS, type SchoolDate, type Weekday } from "../calendar/index.ts";
import type { Queryable } from "../db/transaction.ts";
import { Conflict, type ConflictDetail } from "../http/conflict.ts";
import { withConstraintsNamed } from "./constraints.ts";

/**
 * The Academic structure module: a School's Academic Years, the Terms that
 * divide them, and the weekday pattern and exceptions that make each year's
 * Instructional days, stored with their invariants held (migrations/0013,
 * 0014). Which School dates those make Instructional days is the School
 * calendar's to say.
 *
 * Academic Years in a School never overlap, but may leave School dates between
 * them. A year's Terms, once it has any, cover it exactly: none overlaps
 * another, none falls outside the year, and no School date in the year falls
 * in none. A year with no Terms is one not yet divided. Each exception to a
 * year's pattern falls inside the year, and no two share a date.
 *
 * A change that would break one of those is refused as a Conflict naming the
 * rule, with nothing written. Like the Enrollment store, this decides nothing
 * about who may make a change: that is the Access module's decision, made
 * before any of this is reached.
 */

export interface AcademicYear {
  id: string;
  schoolId: string;
  name: string;
  firstDate: SchoolDate;
  lastDate: SchoolDate;
  /** The weekdays that are Instructional days unless an exception says otherwise, Monday first. */
  weekdays: Weekday[];
}

export interface Term {
  id: string;
  schoolId: string;
  academicYearId: string;
  name: string;
  firstDate: SchoolDate;
  lastDate: SchoolDate;
}

/** A date an Academic Year's pattern does not decide: a holiday taken out, or a make-up day put in. */
export interface InstructionalDayException {
  id: string;
  schoolId: string;
  academicYearId: string;
  date: SchoolDate;
  /** True for a date put in, false for one taken out. */
  instructional: boolean;
}

/** An Academic Year with its Terms and its exceptions, each in date order. */
export interface DividedAcademicYear extends AcademicYear {
  terms: Term[];
  exceptions: InstructionalDayException[];
}

/** A Term as a change proposes it: one of the year's own, named by its identifier, or a new one. */
export interface ProposedTerm {
  id: string | null;
  name: string;
  firstDate: SchoolDate;
  lastDate: SchoolDate;
}

/** One record a change made, removed, or altered: `before` is null for one made, `after` for one removed. */
export interface Changed<T> {
  before: T | null;
  after: T | null;
}

/** The pattern a year has unless it is given another: Monday to Friday. */
export const WORKING_WEEK: readonly Weekday[] = WEEKDAYS.slice(0, 5);

const ACADEMIC_YEAR_COLUMNS = `id, school_id AS "schoolId", name,
  to_char(first_date, 'YYYY-MM-DD') AS "firstDate", to_char(last_date, 'YYYY-MM-DD') AS "lastDate", weekdays`;

const TERM_COLUMNS = `id, school_id AS "schoolId", academic_year_id AS "academicYearId", name,
  to_char(first_date, 'YYYY-MM-DD') AS "firstDate", to_char(last_date, 'YYYY-MM-DD') AS "lastDate"`;

const EXCEPTION_COLUMNS = `id, school_id AS "schoolId", academic_year_id AS "academicYearId",
  to_char(date, 'YYYY-MM-DD') AS date, instructional`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An Academic Year as stored, its pattern held as ISO weekday numbers: 1 is Monday. */
type StoredAcademicYear = Omit<AcademicYear, "weekdays"> & { weekdays: number[] };

function fromStored(year: StoredAcademicYear): AcademicYear {
  return { ...year, weekdays: year.weekdays.map((day) => WEEKDAYS[day - 1]!) };
}

/** A pattern as stored: each of its weekdays' ISO numbers, once and in order. */
function storedWeekdays(weekdays: readonly Weekday[]): number[] {
  return WEEKDAYS.flatMap((day, index) => (weekdays.includes(day) ? [index + 1] : []));
}

/** A School's Academic Years in date order, each with its Terms and exceptions in order. */
export async function academicYearsInSchool(database: Queryable, schoolId: string): Promise<DividedAcademicYear[]> {
  const years = await database.query<StoredAcademicYear>(
    `SELECT ${ACADEMIC_YEAR_COLUMNS} FROM app.academic_year WHERE school_id = $1 ORDER BY first_date`,
    [schoolId],
  );
  const terms = await database.query<Term>(
    `SELECT ${TERM_COLUMNS} FROM app.term WHERE school_id = $1 ORDER BY first_date`,
    [schoolId],
  );
  const exceptions = await database.query<InstructionalDayException>(
    `SELECT ${EXCEPTION_COLUMNS} FROM app.instructional_day_exception WHERE school_id = $1 ORDER BY date`,
    [schoolId],
  );
  return years.rows.map((year) => ({
    ...fromStored(year),
    terms: terms.rows.filter((term) => term.academicYearId === year.id),
    exceptions: exceptions.rows.filter((exception) => exception.academicYearId === year.id),
  }));
}

/** The Academic Year with this identifier, in whichever School holds it, or null. */
export async function findAcademicYear(database: Queryable, academicYearId: string): Promise<AcademicYear | null> {
  if (!UUID.test(academicYearId)) {
    return null;
  }
  const { rows } = await database.query<StoredAcademicYear>(
    `SELECT ${ACADEMIC_YEAR_COLUMNS} FROM app.academic_year WHERE id = $1`,
    [academicYearId],
  );
  return rows[0] === undefined ? null : fromStored(rows[0]);
}

/** The Term with this identifier, in whichever School holds it, or null. */
export async function findTerm(database: Queryable, termId: string): Promise<Term | null> {
  if (!UUID.test(termId)) {
    return null;
  }
  const { rows } = await database.query<Term>(`SELECT ${TERM_COLUMNS} FROM app.term WHERE id = $1`, [termId]);
  return rows[0] ?? null;
}

/**
 * Holds a Term until the transaction ends, so it cannot be deleted from under
 * something about to refer to it, and returns it as it now stands, or null if
 * it was deleted since it was found. Its name and bounds may still change.
 *
 * Only for a Term the caller has already been permitted to refer to.
 */
export async function holdTerm(transaction: Queryable, term: Term): Promise<Term | null> {
  const { rows } = await transaction.query<Term>(
    `SELECT ${TERM_COLUMNS} FROM app.term WHERE school_id = $1 AND id = $2 FOR KEY SHARE`,
    [term.schoolId, term.id],
  );
  return rows[0] ?? null;
}

/**
 * Locks an Academic Year until the transaction ends, so no other change to it,
 * its Terms, or its exceptions can interleave, and returns it as it now stands
 * with them, or null if it was deleted since it was found.
 *
 * Only for a year the caller has already been permitted to change: a lock
 * taken first would let a caller who may not act hold up those who may.
 */
export async function lockAcademicYear(
  transaction: Queryable,
  year: AcademicYear,
): Promise<DividedAcademicYear | null> {
  const { rows } = await transaction.query<StoredAcademicYear>(
    `SELECT ${ACADEMIC_YEAR_COLUMNS} FROM app.academic_year
     WHERE school_id = $1 AND id = $2
     FOR UPDATE`,
    [year.schoolId, year.id],
  );
  if (rows[0] === undefined) {
    return null;
  }
  return {
    ...fromStored(rows[0]),
    terms: await termsOf(transaction, year),
    exceptions: await exceptionsOf(transaction, year),
  };
}

/**
 * Creates an Academic Year with no Terms or exceptions yet, or refuses one
 * overlapping another in its School.
 *
 * The database fixes its School's timezone in the same transaction
 * (migrations/0013), for good: deleting the year later does not free it.
 */
export async function createAcademicYear(
  transaction: Queryable,
  { schoolId, name, firstDate, lastDate, weekdays }: Omit<AcademicYear, "id">,
): Promise<DividedAcademicYear> {
  const { rows } = await withOverlapRefused(() =>
    transaction.query<StoredAcademicYear>(
      `INSERT INTO app.academic_year (school_id, name, first_date, last_date, weekdays)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${ACADEMIC_YEAR_COLUMNS}`,
      [schoolId, name, firstDate, lastDate, storedWeekdays(weekdays)],
    ),
  );
  return { ...fromStored(rows[0]!), terms: [], exceptions: [] };
}

/**
 * Changes a locked Academic Year's name, bounds, and weekday pattern, and
 * replaces its Terms with those proposed: one named by its identifier is
 * changed, one with none is created, and one left out is deleted. Without
 * proposed Terms, the year keeps those it has, and they must still cover it.
 * Its exceptions stay as they are, and must still fall inside it.
 *
 * Every proposed identifier must be one of the year's own Terms; the caller
 * checks that, since it is a matter of the request rather than of the year.
 *
 * Returns the year as it now stands, and each record that changed, as it was
 * and as it is. A record stated as it already stands is not among them.
 */
export async function changeAcademicYear(
  transaction: Queryable,
  year: DividedAcademicYear,
  proposed: {
    name: string;
    firstDate: SchoolDate;
    lastDate: SchoolDate;
    weekdays: readonly Weekday[];
    terms: ProposedTerm[] | null;
  },
): Promise<{ year: DividedAcademicYear; changedYear: Changed<AcademicYear> | null; changedTerms: Changed<Term>[] }> {
  const bounds = { firstDate: proposed.firstDate, lastDate: proposed.lastDate };
  const conflict = coverConflict(bounds, proposed.terms ?? year.terms);
  if (conflict !== null) {
    // Terms kept as they are and left outside the year would be stranded.
    throw new Conflict(
      proposed.terms === null && conflict.conflict === "term_outside_academic_year"
        ? { conflict: "dependent", dependent: "term" }
        : conflict,
    );
  }
  if (year.exceptions.some((exception) => !isWithin(bounds, exception.date))) {
    throw new Conflict({ conflict: "dependent", dependent: "instructional_day_exception" });
  }

  let changedYear: Changed<AcademicYear> | null = null;
  let current: AcademicYear = year;
  const weekdays = storedWeekdays(proposed.weekdays);
  if (
    proposed.name !== year.name ||
    proposed.firstDate !== year.firstDate ||
    proposed.lastDate !== year.lastDate ||
    weekdays.join() !== storedWeekdays(year.weekdays).join()
  ) {
    const { rows } = await withOverlapRefused(() =>
      transaction.query<StoredAcademicYear>(
        `UPDATE app.academic_year SET name = $3, first_date = $4, last_date = $5, weekdays = $6
         WHERE school_id = $1 AND id = $2
         RETURNING ${ACADEMIC_YEAR_COLUMNS}`,
        [year.schoolId, year.id, proposed.name, proposed.firstDate, proposed.lastDate, weekdays],
      ),
    );
    current = fromStored(rows[0]!);
    changedYear = { before: yearAlone(year), after: current };
  }

  const changedTerms =
    proposed.terms === null ? [] : await replaceTerms(transaction, year, year.terms, proposed.terms);
  return {
    year: { ...current, terms: await termsOf(transaction, year), exceptions: year.exceptions },
    changedYear,
    changedTerms,
  };
}

/**
 * Deletes a locked Academic Year, or refuses while it has Terms or exceptions:
 * they would be left belonging to no year.
 */
export async function deleteAcademicYear(transaction: Queryable, year: DividedAcademicYear): Promise<void> {
  if (year.terms.length > 0) {
    throw new Conflict({ conflict: "dependent", dependent: "term" });
  }
  if (year.exceptions.length > 0) {
    throw new Conflict({ conflict: "dependent", dependent: "instructional_day_exception" });
  }
  await transaction.query(`DELETE FROM app.academic_year WHERE school_id = $1 AND id = $2`, [year.schoolId, year.id]);
}

/**
 * Adds an exception to a locked Academic Year's pattern, or refuses one outside
 * the year or on a date that already has one.
 */
export async function addException(
  transaction: Queryable,
  year: DividedAcademicYear,
  { date, instructional }: { date: SchoolDate; instructional: boolean },
): Promise<{ year: DividedAcademicYear; added: InstructionalDayException }> {
  if (!isWithin(year, date)) {
    throw new Conflict({ conflict: "exception_outside_academic_year" });
  }
  // Any other exception on this date would be outside its own year.
  if (year.exceptions.some((exception) => exception.date === date)) {
    throw new Conflict({ conflict: "exception_date_taken" });
  }
  const { rows } = await transaction.query<InstructionalDayException>(
    `INSERT INTO app.instructional_day_exception (school_id, academic_year_id, date, instructional)
     VALUES ($1, $2, $3, $4)
     RETURNING ${EXCEPTION_COLUMNS}`,
    [year.schoolId, year.id, date, instructional],
  );
  return { year: { ...year, exceptions: await exceptionsOf(transaction, year) }, added: rows[0]! };
}

/** Removes one of a locked Academic Year's exceptions, returning its date to the pattern. */
export async function removeException(
  transaction: Queryable,
  year: DividedAcademicYear,
  exception: InstructionalDayException,
): Promise<DividedAcademicYear> {
  await transaction.query(`DELETE FROM app.instructional_day_exception WHERE school_id = $1 AND id = $2`, [
    exception.schoolId,
    exception.id,
  ]);
  return { ...year, exceptions: year.exceptions.filter((each) => each.id !== exception.id) };
}

/** A year's Terms, in order. */
async function termsOf(database: Queryable, year: AcademicYear): Promise<Term[]> {
  const { rows } = await database.query<Term>(
    `SELECT ${TERM_COLUMNS} FROM app.term WHERE school_id = $1 AND academic_year_id = $2 ORDER BY first_date`,
    [year.schoolId, year.id],
  );
  return rows;
}

/** A year's exceptions, in date order. */
async function exceptionsOf(database: Queryable, year: AcademicYear): Promise<InstructionalDayException[]> {
  const { rows } = await database.query<InstructionalDayException>(
    `SELECT ${EXCEPTION_COLUMNS} FROM app.instructional_day_exception
     WHERE school_id = $1 AND academic_year_id = $2
     ORDER BY date`,
    [year.schoolId, year.id],
  );
  return rows;
}

/** A year as it stands apart from its Terms and exceptions, which are recorded as records of their own. */
function yearAlone(year: AcademicYear): AcademicYear {
  const { id, schoolId, name, firstDate, lastDate, weekdays } = year;
  return { id, schoolId, name, firstDate, lastDate, weekdays };
}

/**
 * Writes the proposed Terms over the current ones. The order of the writes does
 * not matter: the overlap constraint is checked when the transaction commits,
 * by which time the whole set has been checked here already.
 */
async function replaceTerms(
  transaction: Queryable,
  year: AcademicYear,
  current: Term[],
  proposed: ProposedTerm[],
): Promise<Changed<Term>[]> {
  const changed: Changed<Term>[] = [];
  const kept = new Set(proposed.flatMap((term) => (term.id === null ? [] : [term.id])));

  for (const term of current.filter((each) => !kept.has(each.id))) {
    // A Term with Class Offerings would leave them offered in no Term.
    await withConstraintsNamed({ class_offering_term_fk: { conflict: "dependent", dependent: "class_offering" } }, () =>
      transaction.query(`DELETE FROM app.term WHERE school_id = $1 AND id = $2`, [term.schoolId, term.id]),
    );
    changed.push({ before: term, after: null });
  }

  for (const term of proposed) {
    if (term.id === null) {
      const { rows } = await transaction.query<Term>(
        `INSERT INTO app.term (school_id, academic_year_id, name, first_date, last_date)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${TERM_COLUMNS}`,
        [year.schoolId, year.id, term.name, term.firstDate, term.lastDate],
      );
      changed.push({ before: null, after: rows[0]! });
      continue;
    }
    const before = current.find((each) => each.id === term.id)!;
    if (before.name === term.name && before.firstDate === term.firstDate && before.lastDate === term.lastDate) {
      continue;
    }
    // A Teaching assignment or Roster membership left outside the Term's new bounds would be stranded.
    const { rows } = await withConstraintsNamed(
      {
        teaching_assignment_inside_term: { conflict: "dependent", dependent: "teaching_assignment" },
        roster_membership_inside_term: { conflict: "dependent", dependent: "roster_membership" },
      },
      () =>
        transaction.query<Term>(
          `UPDATE app.term SET name = $3, first_date = $4, last_date = $5
           WHERE school_id = $1 AND id = $2
           RETURNING ${TERM_COLUMNS}`,
          [before.schoolId, before.id, term.name, term.firstDate, term.lastDate],
        ),
    );
    changed.push({ before, after: rows[0]! });
  }
  return changed;
}

/**
 * Which rule these Terms would break as the whole of a year with these bounds,
 * or null when they cover it exactly. No Terms at all is a year not yet
 * divided, which breaks none.
 *
 * Each Term's own bounds are in order already; the request was refused
 * otherwise.
 */
function coverConflict(
  year: { firstDate: SchoolDate; lastDate: SchoolDate },
  terms: readonly { firstDate: SchoolDate; lastDate: SchoolDate }[],
): ConflictDetail | null {
  if (terms.length === 0) {
    return null;
  }
  // `YYYY-MM-DD` sorts as the dates do.
  const ordered = [...terms].sort((a, b) => a.firstDate.localeCompare(b.firstDate));
  if (ordered.some((term) => term.firstDate < year.firstDate || term.lastDate > year.lastDate)) {
    return { conflict: "term_outside_academic_year" };
  }
  const pairs = ordered.slice(1).map((term, index) => [ordered[index]!, term] as const);
  if (pairs.some(([earlier, later]) => later.firstDate <= earlier.lastDate)) {
    return { conflict: "term_overlap" };
  }
  const covered =
    ordered[0]!.firstDate === year.firstDate &&
    ordered.at(-1)!.lastDate === year.lastDate &&
    pairs.every(([earlier, later]) => later.firstDate === dayAfter(earlier.lastDate));
  return covered ? null : { conflict: "term_gap" };
}

/** Whether a School date falls within these bounds, both inclusive. `YYYY-MM-DD` sorts as the dates do. */
function isWithin(bounds: { firstDate: SchoolDate; lastDate: SchoolDate }, date: SchoolDate): boolean {
  return bounds.firstDate <= date && date <= bounds.lastDate;
}

function dayAfter(date: SchoolDate): SchoolDate {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** Runs a write that the year-overlap constraint may refuse, refusing it as a Conflict instead. */
function withOverlapRefused<T>(write: () => Promise<T>): Promise<T> {
  return withConstraintsNamed({ academic_year_no_overlap: { conflict: "academic_year_overlap" } }, write);
}
