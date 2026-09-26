import {
  authorizeManageAcademicStructure,
  authorizeManageClassOffering,
  authorizeManageCourse,
  authorizeManageTerm,
  authorizeReadClassOffering,
  authorizeReadOwnClassOfferings,
  authorizeReadOwnRosterMemberships,
  mayReadRosterOf,
  offeringsAtAGlance,
  ownClassOfferings,
  ownRosterMemberships,
  rostersServedOn,
  teachingAssignmentsServedOn,
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
  // browser to show a Term's, and who teaches it and how many are on its
  // roster: see offeringsAtAGlance.
  scope.get("/class-offerings", async (actor) => {
    const schoolId = authorizeManageAcademicStructure(actor);
    const offerings = await classOfferingsInSchool(database, schoolId);
    const glances = await offeringsAtAGlance(database, actor, offerings);
    return {
      classOfferings: offerings.map((offering) => ({ ...presentOffering(offering), ...glances.get(offering.id)! })),
    };
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

  /*
   * Read by a School Administrator, and by anyone ever assigned to teach it,
   * with its Teaching assignments and its roster; and by a Student ever
   * rostered in it, with its Teaching assignments alone.
   */
  scope.get("/class-offerings/:classOfferingId", async (actor, { params }) => {
    const classOfferingId = params["classOfferingId"]!;
    const offering = authorizeReadClassOffering(actor, classOfferingId, await findClassOffering(database, classOfferingId));
    const assignments = await teachingAssignmentsServedOn(database, [offering.id]);
    const roster = mayReadRosterOf(actor, offering)
      ? { rosterMemberships: (await rostersServedOn(database, [offering.id])).get(offering.id)! }
      : {};
    return {
      classOffering: { ...presentOffering(offering), teachingAssignments: assignments.get(offering.id)!, ...roster },
    };
  });

  /*
   * The Class Offerings a Faculty member teaches or taught, each with its
   * Teaching assignments: those still running today or later first, in Term
   * order, then those over, the most recent first.
   */
  scope.get("/account/class-offerings", async (actor) => {
    const schoolId = authorizeReadOwnClassOfferings(actor);
    const { current, past } = await ownClassOfferings(database, actor);
    const offerings = (await classOfferingsInSchool(database, schoolId)).filter(
      (offering) => current.has(offering.id) || past.has(offering.id),
    );
    const assignments = await teachingAssignmentsServedOn(
      database,
      offerings.map((offering) => offering.id),
    );
    const served = (offering: DescribedClassOffering) => ({
      ...presentOffering(offering),
      teachingAssignments: assignments.get(offering.id)!,
    });
    return {
      current: offerings.filter((offering) => current.has(offering.id)).map(served),
      past: offerings
        .filter((offering) => past.has(offering.id))
        .reverse()
        .map(served),
    };
  });

  /*
   * The Class Offerings a Student is or was rostered in, by Term: the Term
   * running today first, then the rest, the latest first. Each names who
   * teaches it and the Student's own Roster memberships in it, and nothing of
   * their classmates.
   */
  scope.get("/account/roster-memberships", async (actor) => {
    const schoolId = authorizeReadOwnRosterMemberships(actor);
    const { today, byOffering } = await ownRosterMemberships(database, actor);
    const offerings = (await classOfferingsInSchool(database, schoolId)).filter((offering) =>
      byOffering.has(offering.id),
    );
    const assignments = await teachingAssignmentsServedOn(
      database,
      offerings.map((offering) => offering.id),
    );
    const terms = new Map<string, { term: ReturnType<typeof presentOffering>["term"]; classOfferings: unknown[] }>();
    for (const offering of offerings) {
      const { term } = presentOffering(offering);
      const entry = terms.get(term.id) ?? { term, classOfferings: [] };
      entry.classOfferings.push({
        ...presentOffering(offering),
        teachingAssignments: assignments.get(offering.id)!,
        rosterMemberships: byOffering.get(offering.id)!,
      });
      terms.set(term.id, entry);
    }
    const isCurrent = ({ term }: { term: { firstDate: string; lastDate: string } }) =>
      term.firstDate <= today && today <= term.lastDate;
    // Listed in Term order, so the rest reversed are the latest first.
    const listed = [...terms.values()].reverse();
    return {
      terms: [...listed.filter(isCurrent), ...listed.filter((entry) => !isCurrent(entry))].map((entry) => ({
        ...entry,
        current: isCurrent(entry),
      })),
    };
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
