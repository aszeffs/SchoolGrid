import type { FastifyInstance } from "fastify";
import { resolvePlatformActor, Refused, type PlatformActor } from "../access/index.ts";
import type { Authenticator } from "../authentication/index.ts";
import type { Database } from "../db/pool.ts";
import { refuse } from "./refusal.ts";

/** The body as sent, not yet validated: validate it after the Access decision, never before. */
export type PlatformHandler = (actor: PlatformActor, request: { body: unknown }) => Promise<unknown>;

/** Registers routes that act on the platform, under `/api/platform`. */
export interface PlatformScope {
  /** Answers 201, since it creates. */
  post(path: string, handler: PlatformHandler): void;
}

/**
 * The boundary every platform request passes through, as http/school-scope.ts
 * is for a School: the caller is resolved to a PlatformActor before the handler
 * runs, and the handler can answer with a value or throw `Refused`, but never
 * send a refusal of its own.
 *
 * A refusal here names no School, so it has no trail to be recorded in, and
 * goes to the log alone.
 */
export function registerPlatformScope(
  app: FastifyInstance,
  database: Database,
  authenticator: Authenticator,
  routes: (scope: PlatformScope) => void,
): void {
  routes({
    post: (path, handler) => {
      app.post(`/platform${path}`, async (request, reply) => {
        try {
          const actor = await resolvePlatformActor(database, await authenticator.authenticate(request));
          return reply.status(201).send(await handler(actor, { body: request.body }));
        } catch (error) {
          if (!(error instanceof Refused)) {
            throw error;
          }
          request.log.info({ reason: error.reason, url: request.url }, "refused");
          return refuse(reply);
        }
      });
    },
  });
}
