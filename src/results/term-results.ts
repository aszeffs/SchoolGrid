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
  /** When the Publication that published it was performed; null for a draft. */
  publishedAt: Date | null;
}

/** A Class Offering in its School. */
export interface OfferingKey {
  schoolId: string;
  classOfferingId: string;
}

/**
 * Why one draft of a save was not applied: its result is published, and so
 * changes only through a Correction request; it changed since it was loaded;
 * or it was given a value the current scale lacks.
 */
export type DraftRefusal = "published" | "stale" | "value_not_in_scale";

/** A result with nothing in it: how a Student with no result reads. */
export const NO_CONTENT: TermResultContent = { value: null, score: null, comment: null };

/** Whether two results say the same thing, whoever recorded them and whatever version they are bound to. */
export function sameContent(one: TermResultContent, other: TermResultContent): boolean {
  return one.value === other.value && one.score === other.score && one.comment === other.comment;
}

const SELECT_TERM_RESULT = `
  SELECT result.id, result.student_person_id AS "studentPersonId", result.result_value_id AS "resultValueId",
         value.label AS value, version.number AS "scaleVersion", result.score::float8 AS score, result.comment,
         result.recorded_by_person_id AS "recordedByPersonId", result.recorded_at AS "recordedAt",
         publication.published_at AS "publishedAt"
  FROM app.term_result result
  LEFT JOIN app.publication publication
    ON publication.school_id = result.school_id AND publication.id = result.publication_id
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

/** A Student's first result in a Class Offering, as recorded. */
export type FirstRecording = OfferingKey & Recording & { studentPersonId: string };

/** A Student's first result in a Class Offering. */
export async function recordTermResult(
  transaction: Queryable,
  { schoolId, classOfferingId, studentPersonId, resultValueId, score, comment, recordedByPersonId }: FirstRecording,
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

/**
 * Records these first results, set by set rather than row by row, for a past
 * a new School starts with: Class Offerings of one School holding no result
 * yet. Like the rest of this module it checks no recording rule; the caller's
 * rosters and values must satisfy them.
 */
export async function recordTermResults(
  transaction: Queryable,
  results: readonly FirstRecording[],
): Promise<void> {
  await transaction.query(
    `INSERT INTO app.term_result
       (school_id, class_offering_id, student_person_id, result_value_id, score, comment, recorded_by_person_id)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::numeric[], $6::text[], $7::uuid[])`,
    [
      results.map((result) => result.schoolId),
      results.map((result) => result.classOfferingId),
      results.map((result) => result.studentPersonId),
      results.map((result) => result.resultValueId),
      results.map((result) => result.score),
      results.map((result) => result.comment),
      results.map((result) => result.recordedByPersonId),
    ],
  );
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

/** A Publication as it was performed: who published how many of a Class Offering's results, when. */
export interface Publication {
  id: string;
  publishedByPersonId: string;
  publishedAt: Date;
  resultCount: number;
}

/**
 * Publishes these results of a Class Offering as one Publication by this
 * Person, and returns it. The caller holds the offering's results, and passes
 * only unpublished ones carrying a value: at least one.
 */
export async function publishTermResults(
  transaction: Queryable,
  { schoolId, classOfferingId }: OfferingKey,
  publishedByPersonId: string,
  results: readonly TermResult[],
): Promise<Publication> {
  const { rows } = await transaction.query<Publication>(
    `INSERT INTO app.publication (school_id, class_offering_id, published_by_person_id, result_count)
     VALUES ($1, $2, $3, $4)
     RETURNING id, published_by_person_id AS "publishedByPersonId", published_at AS "publishedAt",
       result_count AS "resultCount"`,
    [schoolId, classOfferingId, publishedByPersonId, results.length],
  );
  const publication = rows[0]!;
  await transaction.query(`UPDATE app.term_result SET publication_id = $2 WHERE school_id = $1 AND id = ANY($3)`, [
    schoolId,
    publication.id,
    results.map((result) => result.id),
  ]);
  return publication;
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

/**
 * The School date a Student left a Class Offering's roster, when every Roster
 * membership of theirs in it ended before its Term did; null for an active
 * roster member, whose latest runs to the Term's end. Publication waits on an
 * active roster member's value, never on one who left (ADR-0003).
 */
export function leftOn(memberships: readonly RosteredBounds[], termLastDate: string): string | null {
  const last = memberships.map((membership) => membership.lastDate ?? termLastDate).sort().at(-1);
  return last !== undefined && last < termLastDate ? last : null;
}

/** A published result as its Student and permitted readers are served it: what it says, and when it was published. */
export interface PublishedTermResult extends TermResultContent {
  value: string;
  publishedAt: Date;
}

/** Each of these Class Offerings' published results for one Student, by offering. A draft is never among them. */
export async function publishedTermResultsOf(
  database: Queryable,
  { schoolId, studentPersonId, classOfferingIds }: { schoolId: string; studentPersonId: string; classOfferingIds: readonly string[] },
): Promise<Map<string, PublishedTermResult>> {
  const { rows } = await database.query<PublishedTermResult & { classOfferingId: string }>(
    `SELECT result.class_offering_id AS "classOfferingId", value.label AS value, result.score::float8 AS score,
            result.comment, publication.published_at AS "publishedAt"
     FROM app.term_result result
     JOIN app.publication publication
       ON publication.school_id = result.school_id AND publication.id = result.publication_id
     JOIN app.result_value value ON value.school_id = result.school_id AND value.id = result.result_value_id
     WHERE result.school_id = $1 AND result.student_person_id = $2 AND result.class_offering_id = ANY($3)`,
    [schoolId, studentPersonId, classOfferingIds],
  );
  return new Map(rows.map(({ classOfferingId, ...published }) => [classOfferingId, published]));
}

/** The Class Offerings a Student was ever rostered in. */
export async function classOfferingsRosteredIn(
  database: Queryable,
  { schoolId, studentPersonId }: { schoolId: string; studentPersonId: string },
): Promise<Set<string>> {
  const { rows } = await database.query<{ classOfferingId: string }>(
    `SELECT DISTINCT class_offering_id AS "classOfferingId" FROM app.roster_membership
     WHERE school_id = $1 AND student_person_id = $2`,
    [schoolId, studentPersonId],
  );
  return new Set(rows.map((row) => row.classOfferingId));
}
