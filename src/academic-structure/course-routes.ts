import {
  authorizeManageAcademicStructure,
  authorizeManageClassOffering,
  authorizeManageCourse,
  authorizeManageTerm,
  type Actor,
} from "../access/index.ts";
import type { AuditValues } from "../audit/index.ts";
import type { Database } from "../db/pool.ts";
import { withTransaction, type Queryable } from "../db/transaction.ts";
import { InvalidRequest } from "../http/invalid-request.ts";
import { boundedText, fieldsOf, reasonFrom, reasonOnly } from "../http/request-body.ts";
import type { SchoolScope } from "../http/school-scope.ts";
import { recordChange, type RecordKind } from "./audit.ts";
import {
  changeCourse,
  classOfferingsInSchool,
  coursesInSchool,
  createClassOffering,
  createCourse,
  deleteClassOffering,
  deleteCourse,
  findClassOffering,
  findCourse,
  lockClassOffering,
  lockCourse,
  relabelClassOffering,
  type ClassOffering,
  type Course,
  type DescribedClassOffering,
} from "./courses.ts";
import { findTerm, holdTerm, type Term } from "./index.ts";

/** A Course as served. The School is the one addressed. */
function presentCourse({ id, name, code }: Course) {
  return { id, name, code };
}

/** A Class Offering as served, with the Course it offers and the Term, and year, it is offered in. */
function presentOffering({ id, label, course, term }: DescribedClassOffering) {
  return {
    id,
    label,
    course: presentCourse(course),
    term: {
      id: term.id,
      name: term.name,
      firstDate: term.firstDate,
      lastDate: term.lastDate,
      academicYear: { id: term.academicYearId, name: term.academicYearName },
    },
  };
}

const COURSE_RECORD: RecordKind<Course> = { type: "course", values: ({ name, code }): AuditValues => ({ name, code }) };

/** A Class Offering as written to the Audit record, naming the Course and Term it offers. */
const OFFERING_RECORD: RecordKind<ClassOffering> = {
  type: "class_offering",
  values: ({ courseId, termId, label }): AuditValues => ({ courseId, termId, label }),
};

// Validation below runs only once the Access decision has permitted the
// caller: see InvalidRequest.

/** A Course's code, or its label for an offering: optional text, null for none, never blank. */
function optionalText(value: unknown, field: string): string | null {
  return value === undefined || value === null ? null : boundedText(value, field);
}

function parseCourse(body: unknown) {
  const fields = fieldsOf(body, ["name", "code", "reason"]);
  return {
    name: boundedText(fields["name"], "name"),
    code: optionalText(fields["code"], "code"),
    reason: reasonFrom(fields["reason"]),
  };
}

/** A change to a Course: whatever it states of its name and code, over what the Course already holds. */
function parseCourseChange(body: unknown, course: Course) {
  const fields = fieldsOf(body, ["name", "code", "reason"]);
  return {
    name: fields["name"] === undefined ? course.name : boundedText(fields["name"], "name"),
    code: fields["code"] === undefined ? course.code : optionalText(fields["code"], "code"),
    reason: reasonFrom(fields["reason"]),
  };
}

function parseOffering(body: unknown) {
  const fields = fieldsOf(body, ["courseId", "termId", "label", "reason"]);
  const { courseId, termId } = fields;
  if (typeof courseId !== "string" || typeof termId !== "string") {
    throw new InvalidRequest("courseId and termId must each name a record");
  }
  return { courseId, termId, label: optionalText(fields["label"], "label"), reason: reasonFrom(fields["reason"]) };
}

/** A relabelling states the label outright, null for none: it is the only thing about an offering that changes. */
function parseRelabel(body: unknown) {
  const fields = fieldsOf(body, ["label", "reason"]);
  if (fields["label"] === undefined) {
    throw new InvalidRequest("label must be given, or null for none");
  }
  return { label: optionalText(fields["label"], "label"), reason: reasonFrom(fields["reason"]) };
}

/*
 * Each record the actor may act on is found, decided, and only then locked:
 * see lockAcademicYear. One deleted between the two is decided again as the
 * absent record it now is, so the caller is refused as for any other.
 */

async function lockPermittedCourse(transaction: Queryable, actor: Actor, courseId: string): Promise<Course> {
  const permitted = authorizeManageCourse(actor, courseId, await findCourse(transaction, courseId));
  return (await lockCourse(transaction, permitted)) ?? authorizeManageCourse<Course>(actor, courseId, null);
}

async function holdPermittedTerm(transaction: Queryable, actor: Actor, termId: string): Promise<Term> {
  const permitted = authorizeManageTerm(actor, termId, await findTerm(transaction, termId));
  return (await holdTerm(transaction, permitted)) ?? authorizeManageTerm<Term>(actor, termId, null);
}

async function lockPermittedOffering(
  transaction: Queryable,
  actor: Actor,
  classOfferingId: string,
): Promise<DescribedClassOffering> {
  const permitted = authorizeManageClassOffering(
    actor,
    classOfferingId,
    await findClassOffering(transaction, classOfferingId),
  );
  return (
    (await lockClassOffering(transaction, permitted)) ??
    authorizeManageClassOffering<DescribedClassOffering>(actor, classOfferingId, null)
  );
}

/**
 * A School's Courses, and the Class Offerings that offer them in its Terms,
 * shaped by its School Administrator: every decision is the Access module's,
 * asked before anything else about the request is looked at, and every change
 * is recorded in the transaction that makes it.
 *
 * Which Course and Term an offering offers never changes. Offering the Course
 * in another Term is another Class Offering; only its label is relabelled.
 */
export function registerCourseRoutes(scope: SchoolScope, database: Database): void {
  // Every Course at once (ADR-0008), filtered in the browser.
  scope.get("/courses", async (actor) => {
    const schoolId = authorizeManageAcademicStructure(actor);
    return { courses: (await coursesInSchool(database, schoolId)).map(presentCourse) };
  });

  scope.post("/courses", async (actor, { body }) => {
    const schoolId = authorizeManageAcademicStructure(actor);
    const { reason, ...course } = parseCourse(body);
    return withTransaction(database, async (transaction) => {
      const created = await createCourse(transaction, { schoolId, ...course });
      await recordChange(transaction, actor, COURSE_RECORD, { before: null, after: created }, reason);
      return { course: presentCourse(created) };
    });
  });

  scope.patch("/courses/:courseId", async (actor, { params, body }) => {
    return withTransaction(database, async (transaction) => {
      const course = await lockPermittedCourse(transaction, actor, params["courseId"]!);
      const { reason, ...proposed } = parseCourseChange(body, course);
      const changed = await changeCourse(transaction, course, proposed);
      if (changed === null) {
        return { course: presentCourse(course) };
      }
      await recordChange(transaction, actor, COURSE_RECORD, changed, reason);
      return { course: presentCourse(changed.after!) };
    });
  });

  scope.delete("/courses/:courseId", async (actor, { params, body }) => {
    return withTransaction(database, async (transaction) => {
      const course = await lockPermittedCourse(transaction, actor, params["courseId"]!);
      const reason = reasonOnly(body);
      await deleteCourse(transaction, course);
      await recordChange(transaction, actor, COURSE_RECORD, { before: course, after: null }, reason);
      return { course: presentCourse(course) };
    });
  });

  // Every Class Offering at once (ADR-0008), each naming its Term, for the
  // browser to show a Term's.
  scope.get("/class-offerings", async (actor) => {
    const schoolId = authorizeManageAcademicStructure(actor);
    return { classOfferings: (await classOfferingsInSchool(database, schoolId)).map(presentOffering) };
  });

  scope.post("/class-offerings", async (actor, { body }) => {
    authorizeManageAcademicStructure(actor);
    const { courseId, termId, label, reason } = parseOffering(body);
    return withTransaction(database, async (transaction) => {
      const course = await lockPermittedCourse(transaction, actor, courseId);
      const term = await holdPermittedTerm(transaction, actor, termId);
      const created = await createClassOffering(transaction, { course, term, label });
      await recordChange(transaction, actor, OFFERING_RECORD, { before: null, after: created }, reason);
      return { classOffering: presentOffering(created) };
    });
  });

  scope.get("/class-offerings/:classOfferingId", async (actor, { params }) => {
    const classOfferingId = params["classOfferingId"]!;
    const offering = authorizeManageClassOffering(
      actor,
      classOfferingId,
      await findClassOffering(database, classOfferingId),
    );
    return { classOffering: presentOffering(offering) };
  });

  scope.patch("/class-offerings/:classOfferingId", async (actor, { params, body }) => {
    return withTransaction(database, async (transaction) => {
      const offering = await lockPermittedOffering(transaction, actor, params["classOfferingId"]!);
      const { label, reason } = parseRelabel(body);
      const changed = await relabelClassOffering(transaction, offering, label);
      if (changed === null) {
        return { classOffering: presentOffering(offering) };
      }
      await recordChange(transaction, actor, OFFERING_RECORD, changed, reason);
      return { classOffering: presentOffering(changed.after!) };
    });
  });

  scope.delete("/class-offerings/:classOfferingId", async (actor, { params, body }) => {
    return withTransaction(database, async (transaction) => {
      const offering = await lockPermittedOffering(transaction, actor, params["classOfferingId"]!);
      const reason = reasonOnly(body);
      await deleteClassOffering(transaction, offering);
      await recordChange(transaction, actor, OFFERING_RECORD, { before: offering, after: null }, reason);
      return { classOffering: presentOffering(offering) };
    });
  });
}
