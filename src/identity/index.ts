import type { Queryable } from "../db/transaction.ts";

/**
 * The Identity module owns Schools, Persons, and resolving a User account to
 * its Person within one School.
 *
 * Nothing here decides whether anyone may see what it returns. Every lookup is
 * a plain fact about what exists; the Access module alone turns facts into a
 * permission, or into the refusal when there is none.
 */
export interface School {
  id: string;
  name: string;
}

export interface Person {
  id: string;
  schoolId: string;
  displayName: string;
}

export async function createSchool(database: Queryable, { name }: { name: string }): Promise<School> {
  const { rows } = await database.query<School>(
    `INSERT INTO app.school (name) VALUES ($1) RETURNING id, name`,
    [name],
  );
  return rows[0]!;
}

const PERSON_COLUMNS = `id, school_id AS "schoolId", display_name AS "displayName"`;

export async function createPerson(
  database: Queryable,
  {
    schoolId,
    displayName,
    userAccountId,
  }: { schoolId: string; displayName: string; userAccountId?: string },
): Promise<Person> {
  const { rows } = await database.query<Person>(
    `INSERT INTO app.person (school_id, display_name, user_account_id)
     VALUES ($1, $2, $3)
     RETURNING ${PERSON_COLUMNS}`,
    [schoolId, displayName, userAccountId ?? null],
  );
  return rows[0]!;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a caller-supplied identifier could name a row at all. One that cannot
 * is simply absent, and must not reach Postgres, which would answer it with an
 * error rather than with nothing.
 */
function couldIdentify(value: string): boolean {
  return UUID.test(value);
}

/** The Person this User account resolves to in this School, or null. */
export async function personFor(
  database: Queryable,
  { userAccountId, schoolId }: { userAccountId: string; schoolId: string },
): Promise<Person | null> {
  if (!couldIdentify(schoolId)) {
    return null;
  }
  const { rows } = await database.query<Person>(
    `SELECT ${PERSON_COLUMNS} FROM app.person WHERE school_id = $1 AND user_account_id = $2`,
    [schoolId, userAccountId],
  );
  return rows[0] ?? null;
}

/** The Person with this identifier, in whichever School holds it, or null. */
export async function findPerson(database: Queryable, personId: string): Promise<Person | null> {
  if (!couldIdentify(personId)) {
    return null;
  }
  const { rows } = await database.query<Person>(
    `SELECT ${PERSON_COLUMNS} FROM app.person WHERE id = $1`,
    [personId],
  );
  return rows[0] ?? null;
}

export async function personsInSchool(database: Queryable, schoolId: string): Promise<Person[]> {
  const { rows } = await database.query<Person>(
    `SELECT ${PERSON_COLUMNS} FROM app.person WHERE school_id = $1 ORDER BY lower(display_name), display_name, id`,
    [schoolId],
  );
  return rows;
}

/** The Schools in which this User account resolves to a Person. */
export async function schoolsReachedBy(
  database: Queryable,
  userAccountId: string,
): Promise<School[]> {
  const { rows } = await database.query<School>(
    `SELECT school.id, school.name
     FROM app.person person
     JOIN app.school school ON school.id = person.school_id
     WHERE person.user_account_id = $1
     ORDER BY lower(school.name), school.name, school.id`,
    [userAccountId],
  );
  return rows;
}
