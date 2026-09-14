import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { LogLevel } from "./config.ts";
import { registerAuthenticationRoutes } from "./authentication/index.ts";
import type { Database } from "./db/pool.ts";
import { refuse } from "./http/refusal.ts";

export interface ServerOptions {
  database: Database;
  logLevel?: LogLevel;
}

export function buildServer({ database, logLevel = "info" }: ServerOptions): FastifyInstance {
  const app = Fastify({
    logger: logLevel === "silent" ? false : { level: logLevel },
  });

  app.setNotFoundHandler((request, reply) => {
    // The reason lives in the log. Ticket 05 moves it to the Audit record.
    request.log.info({ method: request.method, url: request.url }, "refused: no such route");
    refuse(reply);
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

  registerAuthenticationRoutes(app, database);

  return app;
}
