import type { Queryable } from "../db/transaction.ts";

/**
 * Results: what a Student achieved in a class, recorded as a value from their
 * School's Result value scale (CONTEXT.md: Result value scale).
 *
 * The scale is versioned. A save adds the next version and never changes one
 * already stored, so a result bound to a version keeps its value whatever the
 * School saves later. A School's current scale is its highest-numbered
 * version; every School has one from the moment it is created
 * (migrations/0024).
 *
 * Like the Attendance module, it decides nothing about who may act.
 */

/** One value of a scale: a short label, and what it means when the School says. */
export interface ResultValue {
  label: string;
  description: string | null;
}

/** One version of a School's Result value scale, its values in their order. */
export interface ResultValueScale {
  version: number;
  values: ResultValue[];
}

/** The School's current scale. The caller names a School that exists, so it has one. */
export async function currentResultValueScale(database: Queryable, schoolId: string): Promise<ResultValueScale> {
  const { rows } = await database.query<ResultValueScale>(
    `SELECT version.number AS version,
            json_agg(json_build_object('label', value.label, 'description', value.description)
                     ORDER BY value.position) AS values
     FROM app.result_value_scale_version version
     JOIN app.result_value value ON value.school_id = version.school_id AND value.scale_version_id = version.id
     WHERE version.school_id = $1
       AND version.number = (SELECT max(number) FROM app.result_value_scale_version WHERE school_id = $1)
     GROUP BY version.number`,
    [schoolId],
  );
  return rows[0]!;
}

/**
 * Holds a School's Result value scale until the transaction ends and returns
 * its current version, so two saves take turns and each reads the version the
 * other added. Held by an advisory lock, since no version is ever updated.
 */
export async function holdResultValueScale(transaction: Queryable, schoolId: string): Promise<ResultValueScale> {
  await transaction.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `result_value_scale:${schoolId}`,
  ]);
  return currentResultValueScale(transaction, schoolId);
}

/**
 * Adds the version after `after`, holding these values in this order. The
 * database refuses no values, and two labels the same but for letter case.
 */
export async function saveResultValueScale(
  transaction: Queryable,
  {
    schoolId,
    after,
    values,
    savedByPersonId,
  }: { schoolId: string; after: ResultValueScale; values: readonly ResultValue[]; savedByPersonId: string },
): Promise<ResultValueScale> {
  const version = after.version + 1;
  const { rows } = await transaction.query<{ id: string }>(
    `INSERT INTO app.result_value_scale_version (school_id, number, saved_by_person_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [schoolId, version, savedByPersonId],
  );
  await transaction.query(
    `INSERT INTO app.result_value (school_id, scale_version_id, position, label, description)
     SELECT $1, $2, value.position, value.label, value.description
     FROM unnest($3::text[], $4::text[]) WITH ORDINALITY AS value (label, description, position)`,
    [schoolId, rows[0]!.id, values.map((value) => value.label), values.map((value) => value.description)],
  );
  return { version, values: values.map(({ label, description }) => ({ label, description })) };
}

/** Whether two scales hold the same values in the same order, whatever their versions. */
export function sameValues(one: readonly ResultValue[], other: readonly ResultValue[]): boolean {
  return (
    one.length === other.length &&
    one.every((value, index) => value.label === other[index]!.label && value.description === other[index]!.description)
  );
}
