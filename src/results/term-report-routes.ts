import type { FastifyInstance } from "fastify";
import { authorizeReadTermReport } from "../access/index.ts";
import { presentOffering } from "../academic-structure/course-routes.ts";
import { classOfferingsInSchool, type DescribedClassOffering } from "../academic-structure/courses.ts";
import { classOfferingAttendance } from "../attendance/totals.ts";
import type { Authenticator } from "../authentication/index.ts";
import { schoolDateAt } from "../calendar/index.ts";
import type { Database } from "../db/pool.ts";
import { transactionTime } from "../db/transaction.ts";
import { InvalidRequest } from "../http/invalid-request.ts";
import { registerSchoolScope } from "../http/school-scope.ts";
import { findPerson } from "../identity/index.ts";
import { classOfferingsRosteredIn, publishedTermResultsOf } from "./term-results.ts";

/**
 * The Term report over HTTP (CONTEXT.md: Term report): one Student's view of
 * one Term, each Class Offering they were rostered in with its published Term
 * result and Attendance totals. A draft never appears.
 *
 * Who may read it, and which parts, is the Access module's to decide, asked
 * before anything else about the request is looked at. A part the reader may
 * not read is left out of every offering, with nothing in its place.
 */
export function registerTermReportRoutes(app: FastifyInstance, database: Database, authenticator: Authenticator): void {
  registerSchoolScope(app, database, authenticator, (scope) => {
    // The Terms the Student was rostered in, the latest first, and the report
    // for `termId`, or else for the latest Term already begun, or else the
    // soonest to begin.
    scope.get("/persons/:personId/term-report", async (actor, { params, query }) => {
      const personId = params["personId"]!;
      const { student, termResults, attendanceTotals } = authorizeReadTermReport(
        actor,
        personId,
        await findPerson(database, personId),
      );
      const { schoolId } = student;
      const today = (await schoolDateAt(database, { schoolId, at: await transactionTime(database) }))!;
      const rostered = await classOfferingsRosteredIn(database, { schoolId, studentPersonId: student.id });
      const offerings = (await classOfferingsInSchool(database, schoolId)).filter((offering) => rostered.has(offering.id));
      // Offerings come in Term order, so the Terms do too.
      const terms = [
        ...new Map(offerings.map((offering) => [offering.term.id, presentOffering(offering).term])).values(),
      ].reverse();
      const termId = query["termId"];
      if (termId !== undefined && !terms.some((term) => term.id === termId)) {
        throw new InvalidRequest("termId must name a Term the Student was rostered in");
      }
      const term =
        terms.find((each) => each.id === termId) ?? terms.find((each) => each.firstDate <= today) ?? terms.at(-1) ?? null;
      const held = offerings.filter((offering) => offering.term.id === term?.id);
      const published = termResults
        ? await publishedTermResultsOf(database, {
            schoolId,
            studentPersonId: student.id,
            classOfferingIds: held.map((offering) => offering.id),
          })
        : new Map();
      const served = async (offering: DescribedClassOffering) => {
        const result = published.get(offering.id);
        return {
          ...presentOffering(offering),
          ...(termResults && {
            termResult: result === undefined ? null : { ...result, publishedAt: result.publishedAt.toISOString() },
          }),
          ...(attendanceTotals && {
            attendanceTotals: (
              await classOfferingAttendance(database, { offering, today, studentPersonId: student.id })
            ).students[0]!.totals,
          }),
        };
      };
      const classOfferings = [];
      for (const offering of held) {
        classOfferings.push(await served(offering));
      }
      return {
        termReport: {
          student: { id: student.id, displayName: student.displayName },
          today,
          shows: { termResults, attendanceTotals },
          terms,
          term,
          classOfferings,
        },
      };
    });
  });
}
