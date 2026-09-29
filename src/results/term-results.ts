import type { Queryable } from "../db/transaction.ts";

/**
 * Term results as stored (CONTEXT.md: Term result): at most one per Student
 * and Class Offering, each holding an optional value, score and comment, and
 * who last recorded it when (migrations/0025).
 *
 * A value is one of a Result value scale version's values, so the version a
 * result is bound to is the one its value belongs to. Which version to bind a
 * changed value to is the caller's to choose: see currentResultValueIds.
 */

/** What a result says: the part a save changes, and a stale save is told apart by. */
export interface TermResultContent {
  value: string | null;
  score: number | null;
  comment: string | null;
}

export interface TermResult extends TermResultContent {
  id: string;
  studentPersonId: string;
  /** The value's own row, whose version the result is bound to; null with no value. */
  resultValueId: string | null;
  scaleVersion: number | null;
  recordedByPersonId: string;
  recordedAt: Date;
}

/** A Class Offering in its School. */
export interface OfferingKey {
  schoolId: string;
  classOfferingId: string;
}

/** A result with nothing in it: how a Student with no result reads. */
export const NO_CONTENT: TermResultContent = { value: null, score: null, comment: null };

/** Whether two results say the same thing, whoever recorded them and whatever version they are bound to. */
export function sameContent(one: TermResultContent, other: TermResultContent): boolean {
  return one.value === other.value && one.score === other.score && one.comment === other.comment;
}

const SELECT_TERM_RESULT = `
  SELECT result.id, result.student_person_id AS "studentPersonId", result.result_value_id AS "resultValueId",
         value.label AS value, version.number AS "scaleVersion", result.score::float8 AS score, result.comment,
         result.recorded_by_person_id AS "recordedByPersonId", result.recorded_at AS "recordedAt"
  FROM app.term_result result
  LEFT JOIN app.result_value value ON value.school_id = result.school_id AND value.id = result.result_value_id
  LEFT JOIN app.result_value_scale_version version
    ON version.school_id = value.school_id AND version.id = value.scale_version_id`;

/** Every result in a Class Offering. */
export async function termResultsIn(database: Queryable, { schoolId, classOfferingId }: OfferingKey): Promise<TermResult[]> {
  const { rows } = await database.query<TermResult>(
    `${SELECT_TERM_RESULT} WHERE result.school_id = $1 AND result.class_offering_id = $2`,
    [schoolId, classOfferingId],
  );
  return rows;
}

/**
 * Holds a Class Offering's results until the transaction ends and returns
 * them, so two saves take turns and each reads what the other wrote. Held by an
 * advisory lock, since a first draft adds a row no row lock could cover.
 */
export async function holdTermResults(transaction: Queryable, key: OfferingKey): Promise<TermResult[]> {
  await transaction.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `term_results:${key.classOfferingId}`,
  ]);
  return termResultsIn(transaction, key);
}

async function termResult(database: Queryable, id: string): Promise<TermResult> {
  const { rows } = await database.query<TermResult>(`${SELECT_TERM_RESULT} WHERE result.id = $1`, [id]);
  return rows[0]!;
}

/** What a save writes: the content, with the value as the row its version is bound by. */
export interface Recording {
  resultValueId: string | null;
  score: number | null;
  comment: string | null;
  recordedByPersonId: string;
}

/** A Student's first result in a Class Offering. */
export async function recordTermResult(
  transaction: Queryable,
  { schoolId, classOfferingId, studentPersonId, resultValueId, score, comment, recordedByPersonId }: OfferingKey &
    Recording & { studentPersonId: string },
): Promise<TermResult> {
  const { rows } = await transaction.query<{ id: string }>(
    `INSERT INTO app.term_result
       (school_id, class_offering_id, student_person_id, result_value_id, score, comment, recorded_by_person_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [schoolId, classOfferingId, studentPersonId, resultValueId, score, comment, recordedByPersonId],
  );
  return termResult(transaction, rows[0]!.id);
}

/** Changes a result's content, now recorded by the one who changed it. */
export async function changeTermResult(
  transaction: Queryable,
  current: TermResult,
  { resultValueId, score, comment, recordedByPersonId }: Recording,
): Promise<TermResult> {
  await transaction.query(
    `UPDATE app.term_result
     SET result_value_id = $2, score = $3, comment = $4, recorded_by_person_id = $5, recorded_at = now()
     WHERE id = $1`,
    [current.id, resultValueId, score, comment, recordedByPersonId],
  );
  return termResult(transaction, current.id);
}

/** Each value of the School's current scale version, by label, as the row a result binds to. */
export async function currentResultValueIds(database: Queryable, schoolId: string): Promise<Map<string, string>> {
  const { rows } = await database.query<{ id: string; label: string }>(
    `SELECT value.id, value.label
     FROM app.result_value value
     JOIN app.result_value_scale_version version
       ON version.school_id = value.school_id AND version.id = value.scale_version_id
     WHERE version.school_id = $1
       AND version.number = (SELECT max(number) FROM app.result_value_scale_version WHERE school_id = $1)`,
    [schoolId],
  );
  return new Map(rows.map(({ id, label }) => [label, id]));
}

/** The School dates one Roster membership runs between; an open one runs to the end of its Term. */
export interface RosteredBounds {
  firstDate: string;
  lastDate: string | null;
}

/** Every Student ever rostered in a Class Offering, with each of their Roster memberships of it, earliest first. */
export async function rosteredIn(
  database: Queryable,
  { schoolId, classOfferingId }: OfferingKey,
): Promise<Map<string, RosteredBounds[]>> {
  const { rows } = await database.query<RosteredBounds & { studentPersonId: string }>(
    `SELECT student_person_id AS "studentPersonId", to_char(first_date, 'YYYY-MM-DD') AS "firstDate",
       to_char(last_date, 'YYYY-MM-DD') AS "lastDate"
     FROM app.roster_membership
     WHERE school_id = $1 AND class_offering_id = $2
     ORDER BY first_date, id`,
    [schoolId, classOfferingId],
  );
  const rostered = new Map<string, RosteredBounds[]>();
  for (const { studentPersonId, firstDate, lastDate } of rows) {
    rostered.set(studentPersonId, [...(rostered.get(studentPersonId) ?? []), { firstDate, lastDate }]);
  }
  return rostered;
}
