import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { DEFAULT_RATE_LIMIT, type BuildInfo, type LogLevel, type PublicOrigin, type RateLimit } from "./config.ts";
import { recordAuthenticationAttempt } from "./audit/index.ts";
import { registerAcademicStructureRoutes } from "./academic-structure/routes.ts";
import { registerAccessRoutes } from "./access/routes.ts";
import { registerAuditRoutes } from "./audit/routes.ts";
import { createAuthenticator, registerAuthenticationRoutes } from "./authentication/index.ts";
import { registerCalendarRoutes } from "./calendar/routes.ts";
import type { Database } from "./db/pool.ts";
import { API_PREFIX } from "./http/api.ts";
import { acceptEveryBody } from "./http/body-parsing.ts";
import { Conflict } from "./http/conflict.ts";
import { registerBuildInfoRoute } from "./http/build-info.ts";
import { registerDemoRoute } from "./http/demo.ts";
import { isRateLimited, registerRateLimit, sendRateLimited } from "./http/rate-limit.ts";
import { refuseUnrouted } from "./http/school-scope.ts";
import { registerSecurityHeaders, setSecurityHeaders, type CacheControlFor } from "./http/security-headers.ts";
import { cacheControlFor, serveWebApp, webAppFileFor, type WebApp } from "./http/web-app.ts";
import { registerIdentityRoutes } from "./identity/routes.ts";
import { registerPlatformRoutes } from "./platform/routes.ts";

export interface ServerOptions {
  database: Database;
  logLevel?: LogLevel;
  rateLimit?: RateLimit;
  /** The origin browsers reach the server at. See `Config.publicOrigin`. */
  publicOrigin: PublicOrigin;
  /** What the server was built from, served to anyone. Unless given, it knows nothing. */
  buildInfo?: BuildInfo;
  /** Whether to publish the demo's sign-ins. See `Config.demoMode`. Off unless given. */
  demoMode?: boolean;
  /**
   * The web app, served on every path outside `/api`. Without it, those paths
   * are refused like any other path no route matches.
   */
  webApp?: WebApp;
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
  publicOrigin,
  buildInfo = {},
  demoMode = false,
  webApp,
  onRoute,
}: ServerOptions): FastifyInstance {
  const authenticator = createAuthenticator(database, publicOrigin);
  const cacheControlOf: CacheControlFor = (request) => cacheControlFor(webApp, request);

  const app = Fastify({
    logger: logLevel === "silent" ? false : { level: logLevel },
    // A URL the router cannot take apart — an identifier over its length
    // limit, or one that does not decode — is otherwise answered by Fastify
    // itself, with a status and a body echoing the path. Fastify only says so
    // for a path that matches a route with a parameter, so that answer would
    // confirm the route exists. It is a refusal like an unmatched route.
    frameworkErrors: (_error, request, reply) =>
      refuseUnrouted(database, authenticator, request, setSecurityHeaders(reply, cacheControlOf), "malformed-url"),
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
  registerSecurityHeaders(app, cacheControlOf);

  // The web app's page and assets are served from memory and reach nothing a
  // flood could exhaust, while one page load fetches several of them. Counted,
  // they would spend a browser's allowance before it made a single API call.
  // Exempting them reveals nothing: a path is exempt when the web app answers
  // it, which its 200 already says.
  registerRateLimit(app, rateLimit, (request) =>
    webApp === undefined ? false : webAppFileFor(webApp, request) !== null,
  );

  acceptEveryBody(app);

  app.setNotFoundHandler(
    (request, reply) =>
      (webApp === undefined ? null : serveWebApp(webApp, request, reply)) ??
      refuseUnrouted(database, authenticator, request, reply, "no-such-route"),
  );

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // The limiter stops a request by throwing, so a throttled request arrives
    // here. It is neither malformed nor a refusal, and keeps its own response.
    if (isRateLimited(error)) {
      return sendRateLimited(reply);
    }

    // A conflict is a well-formed change the School's records cannot take, and
    // says which of their rules it would have broken.
    if (error instanceof Conflict) {
      request.log.info({ conflict: error.detail }, "rejected conflicting change");
      return reply.status(409).send({ status: "conflict", ...error.detail });
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

      registerBuildInfoRoute(api, buildInfo);
      registerDemoRoute(api, demoMode);

      registerAuthenticationRoutes(api, {
        database,
        authenticator,
        recordAttempt: recordAuthenticationAttempt,
        publicOrigin,
      });
      registerIdentityRoutes(api, database, authenticator, publicOrigin);
      registerAccessRoutes(api, database, authenticator);
      registerAuditRoutes(api, database, authenticator);
      registerCalendarRoutes(api, database, authenticator);
      registerAcademicStructureRoutes(api, database, authenticator);
      registerPlatformRoutes(api, database, authenticator);
    },
    { prefix: API_PREFIX },
  );

  return app;
}
