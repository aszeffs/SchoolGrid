import type { FastifyInstance } from "fastify";
import { authorizeReadSchoolCalendar } from "../access/index.ts";
import type { Authenticator } from "../authentication/index.ts";
import type { Database } from "../db/pool.ts";
import { transactionTime } from "../db/transaction.ts";
import { instantFrom } from "../http/request-body.ts";
import { registerSchoolScope } from "../http/school-scope.ts";
import { isInstructionalDay, schoolDateAt } from "./index.ts";

/**
 * The School calendar, asked over HTTP: which School date an instant falls on,
 * and whether that date is an Instructional day.
 */
export function registerCalendarRoutes(app: FastifyInstance, database: Database, authenticator: Authenticator): void {
  registerSchoolScope(app, database, authenticator, (scope) => {
    // The instant is `at`, or now when none is named.
    scope.get("/school-date", async (actor, { query }) => {
      const schoolId = authorizeReadSchoolCalendar(actor);
      const at = query["at"] === undefined ? await transactionTime(database) : instantFrom(query["at"], "at");
      // The actor's own School, so it exists.
      const schoolDate = (await schoolDateAt(database, { schoolId, at }))!;
      const instructionalDay = await isInstructionalDay(database, { schoolId, date: schoolDate });
      // The instant is not echoed: the caller named it, or asked for now, and
      // an echo of now would make two identical requests answer differently.
      return { schoolDate, instructionalDay };
    });
  });
}
