import type { Queryable } from "../db/transaction.ts";
import type { Changed, Term } from "./index.ts";
import { withConstraintsNamed } from "./constraints.ts";

/**
 * A School's Courses, and the Class Offerings that offer them in its Terms,
 * stored with their invariants held (migrations/0015).
 *
 * A Course's name, and its code when it has one, each name one Course in the
 * School, ignoring letter case. One Course may be offered more than once in a
 * Term, each offering told apart by a label unique among them. A Course that
 * is offered, or a Term that has Class Offerings, is not deleted: the offering
 * would be left offering nothing, or offered in no Term. Nor is an offering
 * Faculty were ever assigned to (migrations/0016).
 *
 * The database holds each of those, so they hold against concurrent changes
 * too, and a change that would break one is refused as a Conflict naming the
 * rule, with nothing written. Like the rest of this module, this decides
 * nothing about who may make a change.
 */

export interface Course {
  id: string;
  schoolId: string;
  name: string;
  code: string | null;
}

export interface ClassOffering {
  id: string;
  schoolId: string;
  courseId: string;
  termId: string;
  /** What tells this offering apart from the Course's others in the Term, if it has any. */
  label: string | null;
}

/** A Class Offering with the Course it offers and the Term it is offered in, and that Term's Academic Year. */
export interface DescribedClassOffering extends ClassOffering {
  course: Course;
  term: Term & { academicYearName: string };
}

const COURSE_COLUMNS = `id, school_id AS "schoolId", name, code`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COURSE_CONFLICTS = {
  course_name_unique: { conflict: "course_name_taken" },
  course_code_unique: { conflict: "course_code_taken" },
} as const;

const LABEL_CONFLICTS = { class_offering_label_unique: { conflict: "class_offering_label_taken" } } as const;

/** An offering described, as one row: see DESCRIBED_OFFERINGS. */
interface DescribedRow extends ClassOffering {
  courseName: string;
  courseCode: string | null;
  termName: string;
  termFirstDate: string;
  termLastDate: string;
  academicYearId: string;
  academicYearName: string;
}

/**
 * Every Class Offering with its Course, Term, and Academic Year, in the order
 * they are listed: by Term, then Course, then label, an offering with none
 * first. Each query adds its own condition on `o`.
 */
const DESCRIBED_OFFERINGS = `
  SELECT o.id, o.school_id AS "schoolId", o.course_id AS "courseId", o.term_id AS "termId", o.label,
    c.name AS "courseName", c.code AS "courseCode",
    t.name AS "termName", to_char(t.first_date, 'YYYY-MM-DD') AS "termFirstDate",
    to_char(t.last_date, 'YYYY-MM-DD') AS "termLastDate",
    y.id AS "academicYearId", y.name AS "academicYearName"
  FROM app.class_offering o
  JOIN app.course c ON c.school_id = o.school_id AND c.id = o.course_id
  JOIN app.term t ON t.school_id = o.school_id AND t.id = o.term_id
  JOIN app.academic_year y ON y.school_id = t.school_id AND y.id = t.academic_year_id`;

const OFFERING_ORDER = `ORDER BY t.first_date, lower(c.name), o.label NULLS FIRST, lower(o.label)`;

function described(row: DescribedRow): DescribedClassOffering {
  const { id, schoolId, courseId, termId, label } = row;
  return {
    id,
    schoolId,
    courseId,
    termId,
    label,
    course: { id: courseId, schoolId, name: row.courseName, code: row.courseCode },
    term: {
      id: termId,
      schoolId,
      academicYearId: row.academicYearId,
      name: row.termName,
      firstDate: row.termFirstDate,
      lastDate: row.termLastDate,
      academicYearName: row.academicYearName,
    },
  };
}

/** A School's Courses, by name. */
export async function coursesInSchool(database: Queryable, schoolId: string): Promise<Course[]> {
  const { rows } = await database.query<Course>(
    `SELECT ${COURSE_COLUMNS} FROM app.course WHERE school_id = $1 ORDER BY lower(name), name`,
    [schoolId],
  );
  return rows;
}

/** The Course with this identifier, in whichever School holds it, or null. */
export async function findCourse(database: Queryable, courseId: string): Promise<Course | null> {
  if (!UUID.test(courseId)) {
    return null;
  }
  const { rows } = await database.query<Course>(`SELECT ${COURSE_COLUMNS} FROM app.course WHERE id = $1`, [courseId]);
  return rows[0] ?? null;
}

/**
 * Locks a Course until the transaction ends, and returns it as it now stands,
 * or null if it was deleted since it was found. Only for a Course the caller
 * has already been permitted to change.
 */
export async function lockCourse(transaction: Queryable, course: Course): Promise<Course | null> {
  const { rows } = await transaction.query<Course>(
    `SELECT ${COURSE_COLUMNS} FROM app.course WHERE school_id = $1 AND id = $2 FOR UPDATE`,
    [course.schoolId, course.id],
  );
  return rows[0] ?? null;
}

/** Creates a Course, or refuses one whose name or code another in its School has. */
export async function createCourse(transaction: Queryable, course: Omit<Course, "id">): Promise<Course> {
  const { rows } = await withConstraintsNamed(COURSE_CONFLICTS, () =>
    transaction.query<Course>(
      `INSERT INTO app.course (school_id, name, code) VALUES ($1, $2, $3) RETURNING ${COURSE_COLUMNS}`,
      [course.schoolId, course.name, course.code],
    ),
  );
  return rows[0]!;
}

/**
 * Renames and recodes a locked Course, or refuses a name or code another in its
 * School has. Returns it as it was and as it is, or null when the change
 * states what it already holds.
 */
export async function changeCourse(
  transaction: Queryable,
  course: Course,
  { name, code }: { name: string; code: string | null },
): Promise<Changed<Course> | null> {
  if (name === course.name && code === course.code) {
    return null;
  }
  const { rows } = await withConstraintsNamed(COURSE_CONFLICTS, () =>
    transaction.query<Course>(
      `UPDATE app.course SET name = $3, code = $4 WHERE school_id = $1 AND id = $2 RETURNING ${COURSE_COLUMNS}`,
      [course.schoolId, course.id, name, code],
    ),
  );
  return { before: course, after: rows[0]! };
}

/** Deletes a locked Course, or refuses while it is offered. */
export async function deleteCourse(transaction: Queryable, course: Course): Promise<void> {
  await withConstraintsNamed({ class_offering_course_fk: { conflict: "dependent", dependent: "class_offering" } }, () =>
    transaction.query(`DELETE FROM app.course WHERE school_id = $1 AND id = $2`, [course.schoolId, course.id]),
  );
}

/** A School's Class Offerings, each described, by Term, then Course, then label. */
export async function classOfferingsInSchool(database: Queryable, schoolId: string): Promise<DescribedClassOffering[]> {
  const { rows } = await database.query<DescribedRow>(`${DESCRIBED_OFFERINGS} WHERE o.school_id = $1 ${OFFERING_ORDER}`, [
    schoolId,
  ]);
  return rows.map(described);
}

/** The Class Offering with this identifier, described, in whichever School holds it, or null. */
export async function findClassOffering(
  database: Queryable,
  classOfferingId: string,
): Promise<DescribedClassOffering | null> {
  if (!UUID.test(classOfferingId)) {
    return null;
  }
  const { rows } = await database.query<DescribedRow>(`${DESCRIBED_OFFERINGS} WHERE o.id = $1`, [classOfferingId]);
  return rows[0] === undefined ? null : described(rows[0]);
}

/**
 * Locks a Class Offering until the transaction ends, and returns it as it now
 * stands, or null if it was deleted since it was found. Only for an offering
 * the caller has already been permitted to change.
 */
export async function lockClassOffering(
  transaction: Queryable,
  offering: ClassOffering,
): Promise<DescribedClassOffering | null> {
  const { rows } = await transaction.query<DescribedRow>(
    `${DESCRIBED_OFFERINGS} WHERE o.school_id = $1 AND o.id = $2 FOR UPDATE OF o`,
    [offering.schoolId, offering.id],
  );
  return rows[0] === undefined ? null : described(rows[0]);
}

/**
 * Offers a locked Course in a held Term, or refuses a label another offering
 * of the Course in the Term has.
 */
export async function createClassOffering(
  transaction: Queryable,
  { course, term, label }: { course: Course; term: Term; label: string | null },
): Promise<DescribedClassOffering> {
  const { rows } = await withConstraintsNamed(LABEL_CONFLICTS, () =>
    transaction.query<{ id: string }>(
      `INSERT INTO app.class_offering (school_id, course_id, term_id, label) VALUES ($1, $2, $3, $4) RETURNING id`,
      [course.schoolId, course.id, term.id, label],
    ),
  );
  return (await findClassOffering(transaction, rows[0]!.id))!;
}

/**
 * Relabels a locked Class Offering, or refuses a label another offering of its
 * Course in its Term has. Returns it as it was and as it is, or null when the
 * change states the label it already has.
 */
export async function relabelClassOffering(
  transaction: Queryable,
  offering: DescribedClassOffering,
  label: string | null,
): Promise<Changed<DescribedClassOffering> | null> {
  if (label === offering.label) {
    return null;
  }
  await withConstraintsNamed(LABEL_CONFLICTS, () =>
    transaction.query(`UPDATE app.class_offering SET label = $3 WHERE school_id = $1 AND id = $2`, [
      offering.schoolId,
      offering.id,
      label,
    ]),
  );
  return { before: offering, after: { ...offering, label } };
}

/** Deletes a locked Class Offering, or refuses while Faculty are assigned to it, ended assignments included. */
export async function deleteClassOffering(transaction: Queryable, offering: ClassOffering): Promise<void> {
  await withConstraintsNamed(
    { teaching_assignment_class_offering_fk: { conflict: "dependent", dependent: "teaching_assignment" } },
    () =>
      transaction.query(`DELETE FROM app.class_offering WHERE school_id = $1 AND id = $2`, [
        offering.schoolId,
        offering.id,
      ]),
  );
}
