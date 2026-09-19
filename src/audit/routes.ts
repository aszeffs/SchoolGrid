import type { FastifyInstance } from "fastify";
import type { Authenticator } from "../authentication/index.ts";
import { authorizeReadAuditRecords } from "../access/index.ts";
import type { Database } from "../db/pool.ts";
import { registerSchoolScope } from "../http/school-scope.ts";
import { readAuditRecords } from "./index.ts";

export function registerAuditRoutes(
  app: FastifyInstance,
  database: Database,
  authenticator: Authenticator,
): void {
  registerSchoolScope(app, database, authenticator, (scope) => {
    // Reads the trail of the School the caller resolved into, and no other: the
    // School comes from the Actor, never from anything else in the request.
    scope.get("/audit-records", async (actor) => {
      const schoolId = authorizeReadAuditRecords(actor);
      return { auditRecords: await readAuditRecords(database, schoolId) };
    });
  });
}
