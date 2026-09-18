import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * The headers every response carries, alongside a `cache-control` that depends
 * on the request (see `CacheControlFor`).
 *
 * The Content Security Policy is enforced, not report-only: nothing is served
 * inline, so nothing needs an exception. `no-referrer` keeps an Invitation link
 * from ever reaching another site.
 *
 * They are the same on every response, whatever its status, so they cannot
 * tell one refusal from another (ADR-0002).
 */
const SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

/**
 * How long a browser may keep a response.
 *
 * - `no-store`: not at all. Every response under `/api`, whatever its status,
 *   so a shared computer's cache never retains Student data.
 * - `no-cache`: kept, but revalidated before each use. The web app's page,
 *   whose name stays the same while its contents change with every deploy.
 * - `max-age=31536000, immutable`: kept for a year and never revalidated. A
 *   file whose contents cannot change under its name.
 */
export type CacheControl = "no-store" | "no-cache" | typeof IMMUTABLE;

export const IMMUTABLE = "max-age=31536000, immutable";

/**
 * The `cache-control` a response to the request carries. Set with the other
 * headers and kept by the same two hooks, so no route can weaken it either.
 * On a refusal it must not depend on what exists, or it could tell one refusal
 * from another (ADR-0002).
 */
export type CacheControlFor = (request: FastifyRequest) => CacheControl;

/**
 * Sets the security headers on every response the server sends.
 *
 * They are set as the request arrives, so they are sent ahead of every header a
 * handler adds: sent in one order on one refusal and another order on the next,
 * the refusals would differ (ADR-0002). An error keeps them, and so does a
 * request the rate limit stops, since this hook runs first. They are set again
 * as the response is sent, so no route can weaken them.
 */
export function registerSecurityHeaders(app: FastifyInstance, cacheControlFor: CacheControlFor): void {
  app.addHook("onRequest", async (_request, reply) => {
    setSecurityHeaders(reply, cacheControlFor);
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    setSecurityHeaders(reply, cacheControlFor);
    return payload;
  });
}

/**
 * Sets the security headers on one reply. Only for a reply no hook will see:
 * Fastify answers a URL its router cannot parse outside every hook. Set before
 * anything else, as the hooks set them.
 */
export function setSecurityHeaders(reply: FastifyReply, cacheControlFor: CacheControlFor): FastifyReply {
  return reply.headers({ ...SECURITY_HEADERS, "cache-control": cacheControlFor(reply.request) });
}
