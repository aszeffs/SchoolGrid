import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RateLimit } from "../config.ts";

/**
 * The body served to a client over the limit.
 *
 * Throttling is not a refusal in the ADR-0002 sense: it is decided by request
 * volume alone, before routing reaches any record, so it cannot reveal whether
 * a record or route exists. It is kept distinct so an honest client knows to
 * back off and retry.
 */
const RATE_LIMITED = { status: "rate_limited" } as const;

const RATE_LIMITED_STATUS = 429;

// The counters change on every request. Served on every response they would
// make two otherwise identical refusals differ, so none of them is ever sent.
const NO_COUNTER_HEADERS = {
  "x-ratelimit-limit": false,
  "x-ratelimit-remaining": false,
  "x-ratelimit-reset": false,
} as const;

/**
 * Limits every route on the server by client address, and every request no
 * route matches, except those `isExempt` says cost nothing worth limiting.
 *
 * The limit is server-wide rather than per-route because every route either
 * reaches the database already or will. It is kept in process memory, so it
 * holds per instance: scaling out multiplies it.
 *
 * The client address is the socket's, or with `clientAddressHeader` that
 * header's value when a request carries it. Only the limit reads it, so
 * Fastify's `trustProxy` stays off and `request.ip` is always the socket's.
 */
export function registerRateLimit(
  app: FastifyInstance,
  { max, windowMs, clientAddressHeader }: RateLimit,
  isExempt: (request: FastifyRequest) => boolean = () => false,
): void {
  app.register(rateLimit, {
    // Applied below as one root hook instead of per route, so it also covers
    // requests for routes that do not exist.
    global: false,
    max,
    timeWindow: windowMs,
    keyGenerator: (request) => clientAddressOf(request, clientAddressHeader),
    // Neither counted nor throttled.
    allowList: (request) => isExempt(request),
    addHeadersOnExceeding: NO_COUNTER_HEADERS,
    // Only the header a throttled client needs in order to back off.
    addHeaders: { ...NO_COUNTER_HEADERS, "retry-after": true },
    errorResponseBuilder: (request) => {
      request.log.info({ method: request.method, url: request.url }, "throttled: rate limit exceeded");
      return Object.assign(new Error("rate limit exceeded"), { statusCode: RATE_LIMITED_STATUS });
    },
  });
  app.after(() => {
    app.addHook("onRequest", app.rateLimit());
  });
}

function clientAddressOf(request: FastifyRequest, header: string | undefined): string {
  const value = header === undefined ? undefined : request.headers[header];
  return typeof value === "string" && value !== "" ? value : request.ip;
}

/** Whether an error handler is looking at a request stopped by the limit. */
export function isRateLimited(error: unknown): boolean {
  return (error as { statusCode?: unknown } | null)?.statusCode === RATE_LIMITED_STATUS;
}

/** Sends the one response served to every client over the limit. */
export function sendRateLimited(reply: FastifyReply): FastifyReply {
  return reply.status(RATE_LIMITED_STATUS).send(RATE_LIMITED);
}
