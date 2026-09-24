import type { SchoolDate } from "../calendar/index.ts";
import type { Queryable } from "../db/transaction.ts";
import { Conflict, type ConflictDetail } from "../http/conflict.ts";

/**
 * The Academic structure module: a School's Academic Years and the Terms that
 * divide them, stored with their invariants held (migrations/0013).
 *
 * Academic Years in a School never overlap, but may leave School dates between
 * them. A year's Terms, once it has any, cover it exactly: none overlaps
 * another, none falls outside the year, and no School date in the year falls
 * in none. A year with no Terms is one not yet divided.
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
}

export interface Term {
  id: string;
  schoolId: string;
  academicYearId: string;
  name: string;
  firstDate: SchoolDate;
  lastDate: SchoolDate;
}

/** An Academic Year with its Terms, in order. */
export interface DividedAcademicYear extends AcademicYear {
  terms: Term[];
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

const ACADEMIC_YEAR_COLUMNS = `id, school_id AS "schoolId", name,
  to_char(first_date, 'YYYY-MM-DD') AS "firstDate", to_char(last_date, 'YYYY-MM-DD') AS "lastDate"`;

const TERM_COLUMNS = `id, school_id AS "schoolId", academic_year_id AS "academicYearId", name,
  to_char(first_date, 'YYYY-MM-DD') AS "firstDate", to_char(last_date, 'YYYY-MM-DD') AS "lastDate"`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const POSTGRES_EXCLUSION_VIOLATION = "23P01";

/** A School's Academic Years in date order, each with its Terms in order. */
export async function academicYearsInSchool(database: Queryable, schoolId: string): Promise<DividedAcademicYear[]> {
  const years = await database.query<AcademicYear>(
    `SELECT ${ACADEMIC_YEAR_COLUMNS} FROM app.academic_year WHERE school_id = $1 ORDER BY first_date`,
    [schoolId],
  );
  const terms = await database.query<Term>(
    `SELECT ${TERM_COLUMNS} FROM app.term WHERE school_id = $1 ORDER BY first_date`,
    [schoolId],
  );
  return years.rows.map((year) => ({
    ...year,
    terms: terms.rows.filter((term) => term.academicYearId === year.id),
  }));
}

/** The Academic Year with this identifier, in whichever School holds it, or null. */
export async function findAcademicYear(database: Queryable, academicYearId: string): Promise<AcademicYear | null> {
  if (!UUID.test(academicYearId)) {
    return null;
  }
  const { rows } = await database.query<AcademicYear>(
    `SELECT ${ACADEMIC_YEAR_COLUMNS} FROM app.academic_year WHERE id = $1`,
    [academicYearId],
  );
  return rows[0] ?? null;
}

/**
 * Locks an Academic Year until the transaction ends, so no other change to it
 * or its Terms can interleave, and returns it as it now stands with its Terms,
 * or null if it was deleted since it was found.
 *
 * Only for a year the caller has already been permitted to change: a lock
 * taken first would let a caller who may not act hold up those who may.
 */
export async function lockAcademicYear(
  transaction: Queryable,
  year: AcademicYear,
): Promise<DividedAcademicYear | null> {
  const { rows } = await transaction.query<AcademicYear>(
    `SELECT ${ACADEMIC_YEAR_COLUMNS} FROM app.academic_year
     WHERE school_id = $1 AND id = $2
     FOR UPDATE`,
    [year.schoolId, year.id],
  );
  if (rows[0] === undefined) {
    return null;
  }
  return { ...rows[0], terms: await termsOf(transaction, year) };
}

/**
 * Creates an Academic Year with no Terms yet, or refuses one overlapping
 * another in its School.
 *
 * The database fixes its School's timezone in the same transaction
 * (migrations/0013), for good: deleting the year later does not free it.
 */
export async function createAcademicYear(
  transaction: Queryable,
  { schoolId, name, firstDate, lastDate }: Omit<AcademicYear, "id">,
): Promise<DividedAcademicYear> {
  const { rows } = await withOverlapRefused(() =>
    transaction.query<AcademicYear>(
      `INSERT INTO app.academic_year (school_id, name, first_date, last_date)
       VALUES ($1, $2, $3, $4)
       RETURNING ${ACADEMIC_YEAR_COLUMNS}`,
      [schoolId, name, firstDate, lastDate],
    ),
  );
  return { ...rows[0]!, terms: [] };
}

/**
 * Changes a locked Academic Year's name and bounds, and replaces its Terms
 * with those proposed: one named by its identifier is changed, one with none
 * is created, and one left out is deleted. Without proposed Terms, the year
 * keeps those it has, and they must still cover it.
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
  proposed: { name: string; firstDate: SchoolDate; lastDate: SchoolDate; terms: ProposedTerm[] | null },
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

  let changedYear: Changed<AcademicYear> | null = null;
  let current: AcademicYear = year;
  if (proposed.name !== year.name || proposed.firstDate !== year.firstDate || proposed.lastDate !== year.lastDate) {
    const { rows } = await withOverlapRefused(() =>
      transaction.query<AcademicYear>(
        `UPDATE app.academic_year SET name = $3, first_date = $4, last_date = $5
         WHERE school_id = $1 AND id = $2
         RETURNING ${ACADEMIC_YEAR_COLUMNS}`,
        [year.schoolId, year.id, proposed.name, proposed.firstDate, proposed.lastDate],
      ),
    );
    current = rows[0]!;
    changedYear = { before: withoutTerms(year), after: current };
  }

  const changedTerms =
    proposed.terms === null ? [] : await replaceTerms(transaction, year, year.terms, proposed.terms);
  return { year: { ...current, terms: await termsOf(transaction, year) }, changedYear, changedTerms };
}

/**
 * Deletes a locked Academic Year, or refuses while it has Terms: they would be
 * left belonging to no year.
 */
export async function deleteAcademicYear(transaction: Queryable, year: DividedAcademicYear): Promise<void> {
  if (year.terms.length > 0) {
    throw new Conflict({ conflict: "dependent", dependent: "term" });
  }
  await transaction.query(`DELETE FROM app.academic_year WHERE school_id = $1 AND id = $2`, [year.schoolId, year.id]);
}

/** A year's Terms, in order. */
async function termsOf(database: Queryable, year: AcademicYear): Promise<Term[]> {
  const { rows } = await database.query<Term>(
    `SELECT ${TERM_COLUMNS} FROM app.term WHERE school_id = $1 AND academic_year_id = $2 ORDER BY first_date`,
    [year.schoolId, year.id],
  );
  return rows;
}

/** A year as it stands apart from its Terms, which are recorded as records of their own. */
function withoutTerms(year: AcademicYear): AcademicYear {
  const { id, schoolId, name, firstDate, lastDate } = year;
  return { id, schoolId, name, firstDate, lastDate };
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
    await transaction.query(`DELETE FROM app.term WHERE school_id = $1 AND id = $2`, [term.schoolId, term.id]);
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
    const { rows } = await transaction.query<Term>(
      `UPDATE app.term SET name = $3, first_date = $4, last_date = $5
       WHERE school_id = $1 AND id = $2
       RETURNING ${TERM_COLUMNS}`,
      [before.schoolId, before.id, term.name, term.firstDate, term.lastDate],
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

function dayAfter(date: SchoolDate): SchoolDate {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** Runs a write that the year-overlap constraint may refuse, refusing it as a Conflict instead. */
async function withOverlapRefused<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isAcademicYearOverlap(error)) {
      throw new Conflict({ conflict: "academic_year_overlap" });
    }
    throw error;
  }
}

function isAcademicYearOverlap(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === POSTGRES_EXCLUSION_VIOLATION &&
    (error as { constraint?: unknown }).constraint === "academic_year_no_overlap"
  );
}
