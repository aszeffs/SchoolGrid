import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { LogLevel } from "./config.ts";
import type { Database } from "./db/pool.ts";

export interface ServerOptions {
  database: Database;
  logLevel?: LogLevel;
}

/**
 * The one body served for every refusal.
 *
 * ADR-0002 requires that an absent record, a record in another School, and a
 * record the caller may not read be indistinguishable. Naming this after any
 * one of those cases — `not_found`, `forbidden` — would bake the rejected
 * two-tier scheme into the shape before ticket 03 builds the real chokepoint
 * on top of it.
 */
const REFUSED = { status: "refused" } as const;

export function buildServer({ database, logLevel = "info" }: ServerOptions): FastifyInstance {
  const app = Fastify({
    logger: logLevel === "silent" ? false : { level: logLevel },
  });

  app.setNotFoundHandler((request, reply) => {
    // The reason lives in the log. Ticket 05 moves it to the Audit record.
    request.log.info({ method: request.method, url: request.url }, "refused: no such route");
    reply.status(404).send(REFUSED);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // A malformed request is the caller's fault and is not a refusal, so it
    // keeps its own status rather than being collapsed into a server error.
    const status = error.statusCode ?? 500;

    if (status >= 400 && status < 500) {
      request.log.info({ err: error, status }, "rejected malformed request");
      return reply.status(status).send({ status: "invalid_request" });
    }

    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send({ status: "internal_error" });
  });

  app.get("/health", async (request, reply) => {
    try {
      await database.query("SELECT 1");
      return reply.status(200).send({ status: "ok", database: "reachable" });
    } catch (error) {
      // Why the database is unreachable is operational detail: logged, never served.
      request.log.error({ err: error }, "health check could not reach the database");
      return reply.status(503).send({ status: "unavailable", database: "unreachable" });
    }
  });

  return app;
}
