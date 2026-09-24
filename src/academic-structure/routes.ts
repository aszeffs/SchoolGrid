import type { FastifyInstance } from "fastify";
import { authorizeManageAcademicStructure, authorizeManageAcademicYear, type Actor } from "../access/index.ts";
import { appendAuditRecord, type AuditValues } from "../audit/index.ts";
import type { Authenticator } from "../authentication/index.ts";
import type { Database } from "../db/pool.ts";
import { withTransaction, type Queryable } from "../db/transaction.ts";
import { InvalidRequest } from "../http/invalid-request.ts";
import { boundedText, fieldsOf, reasonFrom, reasonOnly, schoolDateFrom } from "../http/request-body.ts";
import { registerSchoolScope } from "../http/school-scope.ts";
import {
  academicYearsInSchool,
  changeAcademicYear,
  createAcademicYear,
  deleteAcademicYear,
  findAcademicYear,
  lockAcademicYear,
  type AcademicYear,
  type Changed,
  type DividedAcademicYear,
  type ProposedTerm,
  type Term,
} from "./index.ts";

/** More Terms than any year is divided into, and few enough not to be worth asking about. */
const MAX_TERMS = 100;

/** An Academic Year as served, with its Terms in order. The School is the one addressed. */
function present({ id, name, firstDate, lastDate, terms }: DividedAcademicYear) {
  return {
    id,
    name,
    firstDate,
    lastDate,
    terms: terms.map((term) => ({ id: term.id, name: term.name, firstDate: term.firstDate, lastDate: term.lastDate })),
  };
}

/** An Academic Year as written to the Audit record: its own values, since each Term has a record of its own. */
function yearValues({ name, firstDate, lastDate }: AcademicYear): AuditValues {
  return { name, firstDate, lastDate };
}

/** A Term as written to the Audit record, naming the year it belongs to. */
function termValues({ academicYearId, name, firstDate, lastDate }: Term): AuditValues {
  return { academicYearId, name, firstDate, lastDate };
}

// Validation below runs only once the Access decision has permitted the
// caller: see InvalidRequest.

function parseCreation(body: unknown) {
  const fields = fieldsOf(body, ["name", "firstDate", "lastDate", "reason"]);
  const bounds = boundsFrom(schoolDateFrom(fields["firstDate"], "firstDate"), schoolDateFrom(fields["lastDate"], "lastDate"));
  return { name: boundedText(fields["name"], "name"), ...bounds, reason: reasonFrom(fields["reason"]) };
}

/**
 * A change to an Academic Year: whatever it states of its name and bounds,
 * over what the year already holds, and the whole of its Terms if it states
 * them.
 */
function parseChange(body: unknown, year: DividedAcademicYear) {
  const fields = fieldsOf(body, ["name", "firstDate", "lastDate", "terms", "reason"]);
  const name = fields["name"] === undefined ? year.name : boundedText(fields["name"], "name");
  const bounds = boundsFrom(
    fields["firstDate"] === undefined ? year.firstDate : schoolDateFrom(fields["firstDate"], "firstDate"),
    fields["lastDate"] === undefined ? year.lastDate : schoolDateFrom(fields["lastDate"], "lastDate"),
  );
  const terms = fields["terms"] === undefined ? null : termsFrom(fields["terms"], year);
  return { name, ...bounds, terms, reason: reasonFrom(fields["reason"]) };
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
 * the transaction with its Terms. The decision comes first and the lock
 * second: see lockAcademicYear.
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

/** Records one change to a year or a Term: its creation, deletion, or change. */
async function recordChange<T extends { id: string }>(
  transaction: Queryable,
  actor: Actor,
  { type, values }: { type: string; values: (record: T) => AuditValues },
  { before, after }: Changed<T>,
  reason: string | null,
): Promise<void> {
  await appendAuditRecord(transaction, {
    schoolId: actor.schoolId,
    actorPersonId: actor.person.id,
    action: `${type}.${before === null ? "created" : after === null ? "deleted" : "changed"}`,
    target: { type, id: (after ?? before)!.id },
    reason,
    before: before === null ? null : values(before),
    after: after === null ? null : values(after),
  });
}

/**
 * A School's Academic Years and their Terms, shaped by its School
 * Administrator: every decision is the Access module's, asked before anything
 * else about the request is looked at, and every change is recorded in the
 * transaction that makes it, one Audit record for each year or Term it
 * touched.
 *
 * A year's Terms change together, in the request that changes the year. They
 * cover the year exactly, so moving the boundary between two of them is one
 * change to both; two requests, each moving one side, would each leave a gap
 * or an overlap between them.
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
      return { academicYears: (await academicYearsInSchool(database, schoolId)).map(present) };
    });

    scope.post("/academic-years", async (actor, { body }) => {
      const schoolId = authorizeManageAcademicStructure(actor);
      const { reason, ...year } = parseCreation(body);
      return withTransaction(database, async (transaction) => {
        const created = await createAcademicYear(transaction, { schoolId, ...year });
        await recordChange(transaction, actor, YEAR_RECORD, { before: null, after: created }, reason);
        return { academicYear: present(created) };
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
        return { academicYear: present(changed.year) };
      });
    });

    scope.delete("/academic-years/:academicYearId", async (actor, { params, body }) => {
      return withTransaction(database, async (transaction) => {
        const year = await lockPermitted(transaction, actor, params["academicYearId"]!);
        const reason = reasonOnly(body);
        await deleteAcademicYear(transaction, year);
        await recordChange(transaction, actor, YEAR_RECORD, { before: year, after: null }, reason);
        return { academicYear: present(year) };
      });
    });
  });
}
