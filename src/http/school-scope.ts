import type { FastifyInstance } from "fastify";
import { resolveActor, Refused, type Actor } from "../access/index.ts";
import { accountForRequest } from "../authentication/index.ts";
import type { Database } from "../db/pool.ts";
import { refuse } from "./refusal.ts";

export type SchoolScopedHandler = (
  actor: Actor,
  params: Readonly<Record<string, string>>,
) => Promise<unknown>;

/** Registers routes addressed within a School, under `/schools/:schoolId`. */
export interface SchoolScope {
  get(path: string, handler: SchoolScopedHandler): void;
}

/**
 * The boundary every School-scoped request passes through.
 *
 * It resolves the caller to an Actor once, before the handler runs, and hands
 * the handler that Actor instead of the request: a handler never reads the raw
 * session and never holds the reply, so it can neither skip resolution nor
 * send a refusal of its own. It answers with a value, or it throws `Refused`.
 */
export function registerSchoolScope(
  app: FastifyInstance,
  database: Database,
  routes: (scope: SchoolScope) => void,
): void {
  routes({
    get(path, handler) {
      app.get(`/schools/:schoolId${path}`, async (request, reply) => {
        const params = request.params as Record<string, string>;
        try {
          const actor = await resolveActor(
            database,
            await accountForRequest(database, request),
            params["schoolId"]!,
          );
          return reply.status(200).send(await handler(actor, params));
        } catch (error) {
          if (!(error instanceof Refused)) {
            throw error;
          }
          // This is the School-scoped refusal chokepoint, and it deliberately
          // tells the caller nothing. An absent record, a record in another
          // School, a forbidden record, and a caller with no Person here all
          // leave with the identical response (ADR-0002). The reason goes to the
          // log only. Do not add it to the response to make errors friendlier:
          // any difference lets a caller confirm that a record exists.
          request.log.info({ reason: error.reason, url: request.url }, "refused");
          return refuse(reply);
        }
      });
    },
  });
}
