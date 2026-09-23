import type { FastifyInstance } from "fastify";
import type { Authenticator } from "../authentication/index.ts";
import { authorizeReadAuditRecords } from "../access/index.ts";
import type { Database } from "../db/pool.ts";
import { InvalidRequest } from "../http/invalid-request.ts";
import { registerSchoolScope, type SchoolScopedRequest } from "../http/school-scope.ts";
import { readAuditRecords } from "./index.ts";

/** Records to a page when the caller names no page size, and the most they may name. */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = /^[1-9]\d{0,2}$/;

/**
 * Which page the caller asked for. Called only after the Access decision: a
 * malformed parameter is the caller's own, so saying so reveals nothing to
 * them, but said ahead of the decision it would answer a caller who may not
 * read the trail differently from the refusal (ADR-0008). See InvalidRequest.
 */
function pageOf({ query }: SchoolScopedRequest): { cursor: string | null; limit: number } {
  const { cursor, limit } = query;
  if (cursor !== undefined && (typeof cursor !== "string" || !UUID.test(cursor))) {
    throw new InvalidRequest("cursor must be one this endpoint issued");
  }
  if (limit !== undefined && (typeof limit !== "string" || !PAGE_SIZE.test(limit) || Number(limit) > MAX_PAGE_SIZE)) {
    throw new InvalidRequest(`limit must be a whole number from 1 to ${MAX_PAGE_SIZE}`);
  }
  return { cursor: cursor ?? null, limit: limit === undefined ? DEFAULT_PAGE_SIZE : Number(limit) };
}

export function registerAuditRoutes(
  app: FastifyInstance,
  database: Database,
  authenticator: Authenticator,
): void {
  registerSchoolScope(app, database, authenticator, (scope) => {
    // Reads the trail of the School the caller resolved into, and no other: the
    // School comes from the Actor, never from anything else in the request.
    scope.get("/audit-records", async (actor, request) => {
      const schoolId = authorizeReadAuditRecords(actor);
      const page = await readAuditRecords(database, schoolId, pageOf(request));
      if (page === null) {
        throw new InvalidRequest("cursor must be one this endpoint issued");
      }
      return page;
    });
  });
}
