import type { FastifyRequest } from "fastify";

/**
 * How a request carries its session, and how a response hands one back.
 *
 * Everything here is decided from the request alone, before anything is looked
 * up: whether a session is presented at all, in which form, and whether what
 * was presented could be a token. Nothing here reads the database, and nothing
 * here decides whether a session is live — that is the Authenticator's job in
 * authentication/index.ts.
 */

/** A browser holds its session in a cookie, every other client in a Bearer token (ADR-0004). */
export type SessionForm = "cookie" | "bearer";

/** Why a request belongs to no User account. */
export type AuthenticationFailure =
  /** No session, or one that is malformed, unrecognised, ended, or expired. */
  | "unauthenticated"
  /** A change authenticated by the cookie, not sent from the public origin. */
  | "cross-origin"
  /** Both a cookie and a Bearer token, or the cookie more than once. */
  | "ambiguous-session";

export type PresentedSession =
  | { form: SessionForm; token: string | null; failure?: never }
  | { failure: AuthenticationFailure };

/**
 * The cookie a browser holds its session in (ADR-0004). The `__Host-` prefix
 * makes a browser keep it only if it is `Secure`, has `Path=/` and names no
 * domain, so no other host, subdomain included, can set or overwrite it.
 */
const SESSION_COOKIE = "__Host-session";
const SESSION_COOKIE_ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Strict";

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; ${SESSION_COOKIE_ATTRIBUTES}`;
}

/** Replaces the session cookie with one the browser discards at once. */
export const EXPIRED_SESSION_COOKIE = `${SESSION_COOKIE}=; ${SESSION_COOKIE_ATTRIBUTES}; Max-Age=0`;

/** The shape every session token has, whatever form it was presented in. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * `Bearer <token>`, capturing the token. Only the Bearer scheme is a session:
 * another scheme, such as a proxy's Basic credentials, is not one, and does
 * not conflict with the cookie.
 *
 * The three alternatives are the scheme and one space before the rest of the
 * header, the scheme before any other whitespace, and the scheme alone. Only
 * the first names a token; under the other two the request presents the Bearer
 * scheme and nothing that could be one.
 */
const BEARER = /^bearer(?: (.*)$|(?=\s)|$)/i;

// A browser attaches the cookie to any request a page can make it send. These
// change nothing, so they are not what the Origin check guards.
const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

/** Whether the request was sent by a page on SchoolGrid's own origin. */
export function fromPublicOrigin(request: FastifyRequest, publicOrigin: string): boolean {
  return request.headers.origin === publicOrigin;
}

/** The values of every session cookie the request carries. */
function sessionCookieValues(request: FastifyRequest): string[] {
  return (request.headers.cookie ?? "").split(";").flatMap((pair) => {
    const separator = pair.indexOf("=");
    if (separator === -1 || pair.slice(0, separator).trim() !== SESSION_COOKIE) {
      return [];
    }
    return [pair.slice(separator + 1).trim()];
  });
}

/**
 * Whether the request carried a session cookie at all, whatever its value and
 * whether or not a live Session is behind it. Sign-out asks this to decide
 * whether it has a cookie of the caller's own to expire, separately from
 * whether that cookie was usable.
 */
export function carriesSessionCookie(request: FastifyRequest): boolean {
  return sessionCookieValues(request).length > 0;
}

/** A session presented in one form, with a token that could never be one presented as null. */
function presentedIn(form: SessionForm, token: string): PresentedSession {
  return { form, token: TOKEN_PATTERN.test(token) ? token : null };
}

/** How a request presents its session, decided before anything is looked up. */
export function presentedSession(request: FastifyRequest, publicOrigin: string): PresentedSession {
  const cookies = sessionCookieValues(request);
  const bearer = BEARER.exec(request.headers.authorization ?? "");

  // Choosing one over the other would let whoever planted the second decide
  // which session the request acts as, so neither is chosen (ADR-0004).
  if (cookies.length > 1 || (cookies.length === 1 && bearer !== null)) {
    return { failure: "ambiguous-session" };
  }
  if (cookies.length === 1) {
    // SameSite=Strict keeps the cookie off cross-site requests. This is the
    // second defence, not a replacement for it: neither is dropped because the
    // other exists (ADR-0004). Checked before the session is looked up, so a
    // forged change learns nothing about the cookie it rode on.
    if (!SAFE_METHODS.includes(request.method) && !fromPublicOrigin(request, publicOrigin)) {
      return { failure: "cross-origin" };
    }
    return presentedIn("cookie", cookies[0]!);
  }
  if (bearer !== null) {
    return presentedIn("bearer", bearer[1] ?? "");
  }
  return { failure: "unauthenticated" };
}
