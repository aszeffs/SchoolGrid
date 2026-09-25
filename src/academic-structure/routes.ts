import type { FastifyInstance } from "fastify";
import {
  authorizeManageAcademicStructure,
  authorizeManageAcademicYear,
  authorizeManageInstructionalDayException,
  type Actor,
} from "../access/index.ts";
import type { AuditValues } from "../audit/index.ts";
import type { Authenticator } from "../authentication/index.ts";
import { instructionalDaysInSchool, WEEKDAYS, type SchoolDate, type Weekday } from "../calendar/index.ts";
import type { Database } from "../db/pool.ts";
import { withTransaction, type Queryable } from "../db/transaction.ts";
import { InvalidRequest } from "../http/invalid-request.ts";
import { boundedText, fieldsOf, reasonFrom, reasonOnly, schoolDateFrom } from "../http/request-body.ts";
import { registerSchoolScope } from "../http/school-scope.ts";
import { recordChange } from "./audit.ts";
import { registerCourseRoutes } from "./course-routes.ts";
import {
  academicYearsInSchool,
  addException,
  changeAcademicYear,
  createAcademicYear,
  deleteAcademicYear,
  findAcademicYear,
  lockAcademicYear,
  removeException,
  WORKING_WEEK,
  type AcademicYear,
  type DividedAcademicYear,
  type InstructionalDayException,
  type ProposedTerm,
  type Term,
} from "./index.ts";

/** More Terms than any year is divided into, and few enough not to be worth asking about. */
const MAX_TERMS = 100;

/**
 * An Academic Year as served, with its Terms and exceptions in order, and the
 * Instructional days they make. The School is the one addressed.
 */
function present(
  { id, name, firstDate, lastDate, weekdays, exceptions, terms }: DividedAcademicYear,
  instructionalDays: SchoolDate[],
) {
  return {
    id,
    name,
    firstDate,
    lastDate,
    weekdays,
    exceptions: exceptions.map((exception) => ({
      id: exception.id,
      date: exception.date,
      instructional: exception.instructional,
    })),
    instructionalDays,
    terms: terms.map((term) => ({ id: term.id, name: term.name, firstDate: term.firstDate, lastDate: term.lastDate })),
  };
}

/** One Academic Year as served, as it stands in this transaction. */
async function presentOne(transaction: Queryable, year: DividedAcademicYear) {
  const instructionalDays = await instructionalDaysInSchool(transaction, year.schoolId);
  return { academicYear: present(year, instructionalDays.get(year.id) ?? []) };
}

/**
 * An Academic Year as written to the Audit record: its own values, since each
 * Term and exception has a record of its own. A value is never nested, so its
 * pattern is its weekdays in order, separated by commas.
 */
function yearValues({ name, firstDate, lastDate, weekdays }: AcademicYear): AuditValues {
  return { name, firstDate, lastDate, weekdays: weekdays.join(",") };
}

/** A Term as written to the Audit record, naming the year it belongs to. */
function termValues({ academicYearId, name, firstDate, lastDate }: Term): AuditValues {
  return { academicYearId, name, firstDate, lastDate };
}

/** An exception as written to the Audit record, naming the year it belongs to. */
function exceptionValues({ academicYearId, date, instructional }: InstructionalDayException): AuditValues {
  return { academicYearId, date, instructional };
}

// Validation below runs only once the Access decision has permitted the
// caller: see InvalidRequest.

function parseCreation(body: unknown) {
  const fields = fieldsOf(body, ["name", "firstDate", "lastDate", "weekdays", "reason"]);
  const bounds = boundsFrom(schoolDateFrom(fields["firstDate"], "firstDate"), schoolDateFrom(fields["lastDate"], "lastDate"));
  return {
    name: boundedText(fields["name"], "name"),
    ...bounds,
    weekdays: fields["weekdays"] === undefined ? [...WORKING_WEEK] : weekdaysFrom(fields["weekdays"]),
    reason: reasonFrom(fields["reason"]),
  };
}

/**
 * A change to an Academic Year: whatever it states of its name, bounds, and
 * weekday pattern, over what the year already holds, and the whole of its
 * Terms if it states them.
 */
function parseChange(body: unknown, year: DividedAcademicYear) {
  const fields = fieldsOf(body, ["name", "firstDate", "lastDate", "weekdays", "terms", "reason"]);
  const name = fields["name"] === undefined ? year.name : boundedText(fields["name"], "name");
  const bounds = boundsFrom(
    fields["firstDate"] === undefined ? year.firstDate : schoolDateFrom(fields["firstDate"], "firstDate"),
    fields["lastDate"] === undefined ? year.lastDate : schoolDateFrom(fields["lastDate"], "lastDate"),
  );
  const weekdays = fields["weekdays"] === undefined ? year.weekdays : weekdaysFrom(fields["weekdays"]);
  const terms = fields["terms"] === undefined ? null : termsFrom(fields["terms"], year);
  return { name, ...bounds, weekdays, terms, reason: reasonFrom(fields["reason"]) };
}

/** An exception to add: its date, and whether it puts the date in or takes it out. */
function parseException(body: unknown) {
  const fields = fieldsOf(body, ["date", "instructional", "reason"]);
  const instructional = fields["instructional"];
  if (typeof instructional !== "boolean") {
    throw new InvalidRequest("instructional must be true or false");
  }
  return { date: schoolDateFrom(fields["date"], "date"), instructional, reason: reasonFrom(fields["reason"]) };
}

/** A weekday pattern: each day named at most once, in any order, and held Monday first. */
function weekdaysFrom(value: unknown): Weekday[] {
  const named: unknown[] | null = Array.isArray(value) ? value : null;
  if (
    named === null ||
    !named.every((day) => (WEEKDAYS as readonly unknown[]).includes(day)) ||
    new Set(named).size !== named.length
  ) {
    throw new InvalidRequest(`weekdays must name each of ${WEEKDAYS.join(", ")} at most once`);
  }
  return WEEKDAYS.filter((day) => named.includes(day));
}

function boundsFrom(firstDate: string, lastDate: string) {
  if (lastDate < firstDate) {
    throw new InvalidRequest("lastDate must not be before firstDate");
  }
  return { firstDate, lastDate };
}

/**
 * The whole of a year's Terms, as proposed. A Term naming an identifier must
 * be one of the year's own, named once: one from another year, or another
 * School, is simply not among them.
 */
function termsFrom(value: unknown, year: DividedAcademicYear): ProposedTerm[] {
  if (!Array.isArray(value) || value.length > MAX_TERMS) {
    throw new InvalidRequest(`terms must be a list of at most ${MAX_TERMS} Terms`);
  }
  const own = new Set(year.terms.map((term) => term.id));
  const named = new Set<string>();
  return value.map((each: unknown, index) => {
    const fields = fieldsOf(each, ["id", "name", "firstDate", "lastDate"]);
    const id = fields["id"] ?? null;
    if (id !== null && (typeof id !== "string" || !own.has(id) || named.has(id))) {
      throw new InvalidRequest(`terms[${index}].id must name one of this Academic Year's Terms, once`);
    }
    if (id !== null) {
      named.add(id);
    }
    return {
      id,
      name: boundedText(fields["name"], `terms[${index}].name`),
      ...boundsFrom(
        schoolDateFrom(fields["firstDate"], `terms[${index}].firstDate`),
        schoolDateFrom(fields["lastDate"], `terms[${index}].lastDate`),
      ),
    };
  });
}

/**
 * The Academic Year the actor may change or delete, locked for the rest of
 * the transaction with its Terms and exceptions. The decision comes first and
 * the lock second: see lockAcademicYear.
 *
 * A year deleted between the two is decided again as the absent year it now
 * is, so the caller is refused as for any other.
 */
async function lockPermitted(
  transaction: Queryable,
  actor: Actor,
  academicYearId: string,
): Promise<DividedAcademicYear> {
  const permitted = authorizeManageAcademicYear(
    actor,
    academicYearId,
    await findAcademicYear(transaction, academicYearId),
  );
  const locked = await lockAcademicYear(transaction, permitted);
  return locked ?? authorizeManageAcademicYear<DividedAcademicYear>(actor, academicYearId, null);
}

/** How each kind of record this module changes is named and written in the Audit record. */
const YEAR_RECORD = { type: "academic_year", values: yearValues } as const;
const TERM_RECORD = { type: "term", values: termValues } as const;
const EXCEPTION_RECORD = { type: "instructional_day_exception", values: exceptionValues } as const;

/**
 * A School's Academic Years, their Terms, and their Instructional days,
 * shaped by its School Administrator: every decision is the Access module's,
 * asked before anything else about the request is looked at, and every change
 * is recorded in the transaction that makes it, one Audit record for each
 * year, Term, or exception it touched.
 *
 * A year's Terms change together, in the request that changes the year. They
 * cover the year exactly, so moving the boundary between two of them is one
 * change to both; two requests, each moving one side, would each leave a gap
 * or an overlap between them.
 *
 * A year's weekday pattern changes with the year too. Its exceptions are added
 * and removed one at a time, each a record of its own: a holiday turned into a
 * make-up day is one removed and another added.
 */
export function registerAcademicStructureRoutes(
  app: FastifyInstance,
  database: Database,
  authenticator: Authenticator,
): void {
  registerSchoolScope(app, database, authenticator, (scope) => {
    // Every year at once (ADR-0008): a School holds one a year.
    scope.get("/academic-years", async (actor) => {
      const schoolId = authorizeManageAcademicStructure(actor);
      // One snapshot, so each year's Instructional days are those its pattern and exceptions make.
      return withTransaction(database, async (transaction) => {
        const years = await academicYearsInSchool(transaction, schoolId);
        const instructionalDays = await instructionalDaysInSchool(transaction, schoolId);
        return { academicYears: years.map((year) => present(year, instructionalDays.get(year.id) ?? [])) };
      });
    });

    scope.post("/academic-years", async (actor, { body }) => {
      const schoolId = authorizeManageAcademicStructure(actor);
      const { reason, ...year } = parseCreation(body);
      return withTransaction(database, async (transaction) => {
        const created = await createAcademicYear(transaction, { schoolId, ...year });
        await recordChange(transaction, actor, YEAR_RECORD, { before: null, after: created }, reason);
        return presentOne(transaction, created);
      });
    });

    scope.patch("/academic-years/:academicYearId", async (actor, { params, body }) => {
      return withTransaction(database, async (transaction) => {
        const year = await lockPermitted(transaction, actor, params["academicYearId"]!);
        const { reason, ...proposed } = parseChange(body, year);
        const changed = await changeAcademicYear(transaction, year, proposed);
        if (changed.changedYear !== null) {
          await recordChange(transaction, actor, YEAR_RECORD, changed.changedYear, reason);
        }
        for (const term of changed.changedTerms) {
          await recordChange(transaction, actor, TERM_RECORD, term, reason);
        }
        return presentOne(transaction, changed.year);
      });
    });

    scope.delete("/academic-years/:academicYearId", async (actor, { params, body }) => {
      return withTransaction(database, async (transaction) => {
        const year = await lockPermitted(transaction, actor, params["academicYearId"]!);
        const reason = reasonOnly(body);
        await deleteAcademicYear(transaction, year);
        await recordChange(transaction, actor, YEAR_RECORD, { before: year, after: null }, reason);
        // Gone, so it makes no Instructional days now.
        return { academicYear: present(year, []) };
      });
    });

    scope.post("/academic-years/:academicYearId/exceptions", async (actor, { params, body }) => {
      return withTransaction(database, async (transaction) => {
        const year = await lockPermitted(transaction, actor, params["academicYearId"]!);
        const { reason, ...exception } = parseException(body);
        const { year: changed, added } = await addException(transaction, year, exception);
        await recordChange(transaction, actor, EXCEPTION_RECORD, { before: null, after: added }, reason);
        return presentOne(transaction, changed);
      });
    });

    scope.delete("/academic-years/:academicYearId/exceptions/:exceptionId", async (actor, { params, body }) => {
      return withTransaction(database, async (transaction) => {
        const year = await lockPermitted(transaction, actor, params["academicYearId"]!);
        const exceptionId = params["exceptionId"]!;
        // Only the year's own: one of another year, or none at all, is absent from it.
        const exception = authorizeManageInstructionalDayException(
          actor,
          exceptionId,
          year.exceptions.find((each) => each.id === exceptionId) ?? null,
        );
        const reason = reasonOnly(body);
        const changed = await removeException(transaction, year, exception);
        await recordChange(transaction, actor, EXCEPTION_RECORD, { before: exception, after: null }, reason);
        return presentOne(transaction, changed);
      });
    });

    registerCourseRoutes(scope, database);
  });
}
