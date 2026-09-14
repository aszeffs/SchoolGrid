import type { FastifyInstance } from "fastify";

/**
 * Accepts every request body, whatever route it is sent to.
 *
 * A body is read before routing hands the request to anyone who could refuse
 * it. Left to Fastify, a route that exists answers a body that is not JSON, or
 * has a type it does not parse, with its own error, while a path with no route
 * answers the refusal or a different error: the difference confirms which
 * routes exist (ADR-0002). Here a body that cannot be read arrives as no body
 * at all, for the handler to judge once the caller has been authorized. A body
 * over the size limit is still rejected before routing, but alike on every
 * path.
 */
export function acceptEveryBody(app: FastifyInstance): void {
  const parseJson = app.getDefaultJsonParser("error", "error");
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    parseJson(request, body as string, (error, value) => done(null, error ? undefined : value));
  });
  app.addContentTypeParser("*", { parseAs: "string" }, (_request, _body, done) => {
    done(null, undefined);
  });
}
