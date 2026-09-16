import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { DEFAULT_RATE_LIMIT, type LogLevel, type RateLimit } from "./config.ts";
import { recordAuthenticationAttempt } from "./audit/index.ts";
import { registerAccessRoutes } from "./access/routes.ts";
import { registerAuditRoutes } from "./audit/routes.ts";
import { registerAuthenticationRoutes } from "./authentication/index.ts";
import type { Database } from "./db/pool.ts";
import { API_PREFIX } from "./http/api.ts";
import { acceptEveryBody } from "./http/body-parsing.ts";
import { isRateLimited, registerRateLimit, sendRateLimited } from "./http/rate-limit.ts";
import { refuseUnrouted } from "./http/school-scope.ts";
import { registerSecurityHeaders, setSecurityHeaders } from "./http/security-headers.ts";
import { registerIdentityRoutes } from "./identity/routes.ts";
import { registerPlatformRoutes } from "./platform/routes.ts";

export interface ServerOptions {
  database: Database;
  logLevel?: LogLevel;
  rateLimit?: RateLimit;
  /**
   * Told of every route as it is registered, however it is registered. For a
   * test that must cover every route there is, not only those it knew of.
   */
  onRoute?: (route: RegisteredRoute) => void;
}

export interface RegisteredRoute {
  method: string;
  url: string;
}

export function buildServer({
  database,
  logLevel = "info",
  rateLimit = DEFAULT_RATE_LIMIT,
  onRoute,
}: ServerOptions): FastifyInstance {
  const app = Fastify({
    logger: logLevel === "silent" ? false : { level: logLevel },
    // A URL the router cannot take apart — an identifier over its length
    // limit, or one that does not decode — is otherwise answered by Fastify
    // itself, with a status and a body echoing the path. Fastify only says so
    // for a path that matches a route with a parameter, so that answer would
    // confirm the route exists. It is a refusal like an unmatched route.
    frameworkErrors: (_error, request, reply) =>
      refuseUnrouted(database, request, setSecurityHeaders(reply), "malformed-url"),
  });

  // First, so no route is registered before it is listening.
  if (onRoute !== undefined) {
    app.addHook("onRoute", ({ method, url }) => {
      for (const each of [method].flat()) {
        onRoute({ method: each, url });
      }
    });
  }

  // Before the rate limit, so a throttled request has them too.
  registerSecurityHeaders(app);

  registerRateLimit(app, rateLimit);

  acceptEveryBody(app);

  app.setNotFoundHandler((request, reply) =>
    refuseUnrouted(database, request, reply, "no-such-route"),
  );

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // The limiter stops a request by throwing, so a throttled request arrives
    // here. It is neither malformed nor a refusal, and keeps its own response.
    if (isRateLimited(error)) {
      return sendRateLimited(reply);
    }

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

  // Every route, under the one prefix. The refusal, error and rate-limit
  // handling above is the root's, so it covers paths inside and outside alike.
  app.register(
    async (api) => {
      api.get("/health", async (request, reply) => {
        try {
          await database.query("SELECT 1");
          return reply.status(200).send({ status: "ok", database: "reachable" });
        } catch (error) {
          // Why the database is unreachable is operational detail: logged, never served.
          request.log.error({ err: error }, "health check could not reach the database");
          return reply.status(503).send({ status: "unavailable", database: "unreachable" });
        }
      });

      registerAuthenticationRoutes(api, database, recordAuthenticationAttempt);
      registerIdentityRoutes(api, database);
      registerAccessRoutes(api, database);
      registerAuditRoutes(api, database);
      registerPlatformRoutes(api, database);
    },
    { prefix: API_PREFIX },
  );

  return app;
}
