import type { FastifyInstance } from "fastify";
import { authorizeReadSchoolCalendar } from "../access/index.ts";
import type { Authenticator } from "../authentication/index.ts";
import type { Database } from "../db/pool.ts";
import { transactionTime } from "../db/transaction.ts";
import { InvalidRequest } from "../http/invalid-request.ts";
import { instantFrom } from "../http/request-body.ts";
import { registerSchoolScope } from "../http/school-scope.ts";
import { isKnownTimezone, schoolDateAt } from "./index.ts";

/** Longer than any identifier the database knows, and short enough not to be worth asking about. */
const MAX_TIMEZONE_LENGTH = 64;

/**
 * A timezone a School may have, from a request: an IANA identifier the
 * database knows, spelt exactly as it spells it.
 *
 * Throws InvalidRequest, so it runs only once the Access decision has
 * permitted the caller: see InvalidRequest.
 */
export async function timezoneFrom(database: Database, value: unknown): Promise<string> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TIMEZONE_LENGTH ||
    !(await isKnownTimezone(database, value))
  ) {
    throw new InvalidRequest("timezone must be an IANA timezone identifier the database knows");
  }
  return value;
}

/**
 * The School calendar, asked over HTTP: which School date an instant falls on.
 * Instructional days join it when Academic Years carry them.
 */
export function registerCalendarRoutes(app: FastifyInstance, database: Database, authenticator: Authenticator): void {
  registerSchoolScope(app, database, authenticator, (scope) => {
    // The instant is `at`, or now when none is named.
    scope.get("/school-date", async (actor, { query }) => {
      const schoolId = authorizeReadSchoolCalendar(actor);
      const at = query["at"] === undefined ? await transactionTime(database) : instantFrom(query["at"], "at");
      // The actor's own School, so it exists.
      const schoolDate = (await schoolDateAt(database, { schoolId, at }))!;
      return { at: at.toISOString(), schoolDate };
    });
  });
}
