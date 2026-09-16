import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * The headers every response carries.
 *
 * The Content Security Policy is enforced, not report-only: nothing is served
 * inline, so nothing needs an exception. `no-referrer` keeps an Invitation link
 * from ever reaching another site. `no-store` keeps a shared computer's cache
 * from retaining Student data.
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
  "cache-control": "no-store",
} as const;

/**
 * Sets the security headers on every response the server sends.
 *
 * They are set as the request arrives, so they are sent ahead of every header a
 * handler adds: sent in one order on one refusal and another order on the next,
 * the refusals would differ (ADR-0002). An error keeps them, and so does a
 * request the rate limit stops, since this hook runs first. They are set again
 * as the response is sent, so no route can weaken them.
 */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook("onRequest", async (_request, reply) => {
    setSecurityHeaders(reply);
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    setSecurityHeaders(reply);
    return payload;
  });
}

/**
 * Sets the security headers on one reply. Only for a reply no hook will see:
 * Fastify answers a URL its router cannot parse outside every hook. Set before
 * anything else, as the hooks set them.
 */
export function setSecurityHeaders(reply: FastifyReply): FastifyReply {
  return reply.headers(SECURITY_HEADERS);
}
