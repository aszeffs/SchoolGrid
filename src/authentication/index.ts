import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../db/pool.ts";
import { withTransaction, type Queryable } from "../db/transaction.ts";
import { isRateLimited } from "../http/rate-limit.ts";
import { refuse } from "../http/refusal.ts";
import { hashPassword, spendVerificationEffort, verifyPassword } from "./passwords.ts";

/**
 * The Authentication module answers one question for the rest of the system:
 * which User account, if any, does this request belong to.
 *
 * A User account is credentials and authentication state. Nothing here knows
 * about Schools, Persons, roles, or permissions, and nothing exported from
 * here may return one. Resolving an account to a Person is Identity's job.
 */
export interface UserAccount {
  id: string;
  username: string;
}

export interface Credentials {
  username: string;
  password: string;
}

/** A sign-in attempt, and the account it named, if it named one. */
export interface AuthenticationAttempt {
  userAccountId: string | null;
  succeeded: boolean;
}

/**
 * Writes an attempt down somewhere this module need not know about. It is
 * given the transaction a successful attempt's session is started in, so a
 * session whose attempt cannot be recorded is never started.
 */
export type RecordAttempt = (database: Queryable, attempt: AuthenticationAttempt) => Promise<void>;

const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;

// Bounds a malformed attempt rather than an honest one. A password longer than
// this is refused like any other failed attempt, without being hashed.
const MAX_USERNAME_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 1024;

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export async function createUserAccount(
  database: Database,
  { username, password }: Credentials,
): Promise<UserAccount> {
  const { rows } = await database.query<UserAccount>(
    `INSERT INTO app.user_account (username, password_hash)
     VALUES ($1, $2)
     RETURNING id, username`,
    [username, await hashPassword(password)],
  );
  return rows[0]!;
}

/**
 * The account holding this username, matched regardless of letter case and of
 * look-alike Unicode spellings (`app.username_key`), or null. For naming an
 * account to someone permitted to name it, never for deciding who a request
 * belongs to.
 */
export async function findUserAccount(
  database: Queryable,
  username: string,
): Promise<UserAccount | null> {
  const { rows } = await database.query<UserAccount>(
    `SELECT id, username FROM app.user_account
     WHERE app.username_key(username) = app.username_key($1)`,
    [username],
  );
  return rows[0] ?? null;
}

/**
 * The account the credentials verify as or, when they do not, the account they
 * named: null if they named none.
 */
type Verification =
  | { verified: true; account: UserAccount }
  | { verified: false; userAccountId: string | null };

async function verifyCredentials(
  database: Database,
  { username, password }: Credentials,
): Promise<Verification> {
  const { rows } = await database.query<UserAccount & { password_hash: string }>(
    `SELECT id, username, password_hash FROM app.user_account
     WHERE app.username_key(username) = app.username_key($1)`,
    [username],
  );
  const account = rows[0];

  if (account === undefined) {
    await spendVerificationEffort(password);
    return { verified: false, userAccountId: null };
  }
  if (!(await verifyPassword(password, account.password_hash))) {
    return { verified: false, userAccountId: account.id };
  }
  return { verified: true, account: { id: account.id, username: account.username } };
}

async function startSession(
  database: Queryable,
  account: UserAccount,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
  await database.query(
    `INSERT INTO app.user_session (token_hash, user_account_id, expires_at) VALUES ($1, $2, $3)`,
    [hashToken(token), account.id, expiresAt],
  );
  return { token, expiresAt };
}

/** Ends the live session this token names. False if there was none to end. */
async function deleteSession(database: Database, token: string): Promise<boolean> {
  const { rowCount } = await database.query(
    `DELETE FROM app.user_session WHERE token_hash = $1 AND expires_at > now()`,
    [hashToken(token)],
  );
  return rowCount !== null && rowCount > 0;
}

/**
 * The cookie a browser holds its session in (ADR-0004). The `__Host-` prefix
 * makes a browser keep it only if it is `Secure`, has `Path=/` and names no
 * domain, so no other host, subdomain included, can set or overwrite it.
 */
const SESSION_COOKIE = "__Host-session";
const SESSION_COOKIE_ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Strict";

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; ${SESSION_COOKIE_ATTRIBUTES}`;
}

/** Replaces the session cookie with one the browser discards at once. */
const EXPIRED_SESSION_COOKIE = `${SESSION_COOKIE}=; ${SESSION_COOKIE_ATTRIBUTES}; Max-Age=0`;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

// A browser attaches the cookie to any request a page can make it send. These
// change nothing, so they are not what the Origin check guards.
const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

/** Why a request belongs to no User account. */
export type AuthenticationFailure =
  /** No session, or one that is malformed, unrecognised, ended, or expired. */
  | "unauthenticated"
  /** A change authenticated by the cookie, not sent from the public origin. */
  | "cross-origin"
  /** Both a cookie and a Bearer token, or the cookie more than once. */
  | "ambiguous-session";

export type Authentication =
  | { account: UserAccount; failure?: never }
  | { account: null; failure: AuthenticationFailure };

type SessionForm = "cookie" | "bearer";

type PresentedSession =
  | { form: SessionForm; token: string | null; failure?: never }
  | { failure: AuthenticationFailure };

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
 * How a request presents its session, decided before anything is looked up. A
 * token that could never be one is presented as null.
 */
function presentedSession(request: FastifyRequest, publicOrigin: string): PresentedSession {
  const authorization = request.headers.authorization ?? "";
  const cookies = sessionCookieValues(request);
  // Only the Bearer scheme is a session. Another scheme, such as a proxy's
  // Basic credentials, is not one, and does not conflict with the cookie.
  const bearer = /^bearer(\s|$)/i.test(authorization);

  // Choosing one over the other would let whoever planted the second decide
  // which session the request acts as, so neither is chosen (ADR-0004).
  if (cookies.length > 1 || (cookies.length === 1 && bearer)) {
    return { failure: "ambiguous-session" };
  }
  if (cookies.length === 1) {
    // SameSite=Strict keeps the cookie off cross-site requests. This is the
    // second defence, not a replacement for it: neither is dropped because the
    // other exists (ADR-0004). Checked before the session is looked up, so a
    // forged change learns nothing about the cookie it rode on.
    if (!SAFE_METHODS.includes(request.method) && request.headers.origin !== publicOrigin) {
      return { failure: "cross-origin" };
    }
    const token = cookies[0]!;
    return { form: "cookie", token: TOKEN_PATTERN.test(token) ? token : null };
  }
  if (bearer) {
    const token = /^bearer (.*)$/i.exec(authorization)?.[1] ?? "";
    return { form: "bearer", token: TOKEN_PATTERN.test(token) ? token : null };
  }
  return { failure: "unauthenticated" };
}

/**
 * Resolves requests to User accounts. A browser presents its session as a
 * cookie and every other client as a Bearer token, and every route accepts
 * either (ADR-0004).
 */
export interface Authenticator {
  /**
   * The User account a request belongs to, or why it belongs to none. A
   * missing, malformed, unrecognised, ended, or expired session all fail
   * alike: a stale session must grant exactly what no session grants.
   */
  authenticate(request: FastifyRequest): Promise<Authentication>;
  /**
   * Ends the live session the request presents and says how it was presented,
   * or null when it presented none that could be ended.
   */
  endSession(request: FastifyRequest): Promise<SessionForm | null>;
}

/** An Authenticator for SchoolGrid served at `publicOrigin`. */
export function createAuthenticator(database: Database, publicOrigin: string): Authenticator {
  return {
    async authenticate(request) {
      const presented = presentedSession(request, publicOrigin);
      if (presented.failure !== undefined) {
        return { account: null, failure: presented.failure };
      }
      if (presented.token === null) {
        return { account: null, failure: "unauthenticated" };
      }
      const { rows } = await database.query<UserAccount>(
        `SELECT account.id, account.username
         FROM app.user_session session
         JOIN app.user_account account ON account.id = session.user_account_id
         WHERE session.token_hash = $1 AND session.expires_at > now()`,
        [hashToken(presented.token)],
      );
      const account = rows[0];
      return account === undefined ? { account: null, failure: "unauthenticated" } : { account };
    },

    async endSession(request) {
      const presented = presentedSession(request, publicOrigin);
      if (presented.failure !== undefined || presented.token === null) {
        return null;
      }
      return (await deleteSession(database, presented.token)) ? presented.form : null;
    },
  };
}

function parseCredentials(body: unknown): Credentials | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const { username, password } = body as Record<string, unknown>;
  if (
    typeof username !== "string" ||
    typeof password !== "string" ||
    username.length === 0 ||
    password.length === 0 ||
    username.length > MAX_USERNAME_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    return null;
  }
  return { username, password };
}

/**
 * A sign-in attempt: its credentials, and the form its session is to take. A
 * client gets a cookie unless it explicitly asks for a Bearer token.
 */
function parseAttempt(body: unknown): { credentials: Credentials; form: SessionForm } | null {
  const credentials = parseCredentials(body);
  if (credentials === null) {
    return null;
  }
  const { session } = body as Record<string, unknown>;
  if (session !== undefined && session !== "bearer") {
    return null;
  }
  return { credentials, form: session === "bearer" ? "bearer" : "cookie" };
}

function parseJsonOrNothing(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

interface AuthenticationOptions {
  database: Database;
  authenticator: Authenticator;
  recordAttempt: RecordAttempt;
}

async function authenticationRoutes(
  app: FastifyInstance,
  { database, authenticator, recordAttempt }: AuthenticationOptions,
): Promise<void> {
  async function refuseMalformedAttempt(request: FastifyRequest, reply: FastifyReply) {
    request.log.info("refused: malformed authentication attempt");
    // A malformed attempt costs what a wrong password costs, so it cannot be
    // told apart by timing either. That includes recording it: it names no
    // account, so nothing is written, but the write is still made.
    await spendVerificationEffort("");
    await recordAttempt(database, { userAccountId: null, succeeded: false });
    return refuse(reply);
  }

  // Every failed attempt, whatever its cause, must get the one refusal. Left to
  // Fastify, an unparseable body or an unexpected content type fails before the
  // handler runs, is answered `invalid_request`, and carries `connection: close`
  // — all distinguishable from a wrong password. Within this plugin any body is
  // accepted, and one that is not valid JSON, declared as JSON, arrives as no
  // credentials at all.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, parseJsonOrNothing(body as string));
  });
  app.addContentTypeParser("*", { parseAs: "string" }, (_request, _body, done) => {
    done(null, undefined);
  });

  // The remaining way to fail before the handler is a body over Fastify's size
  // limit. That still refuses identically here, but keeps the `connection:
  // close` Fastify adds, because the unread body must not be left on the socket.
  // Server errors, and a request stopped by the rate limit, are rethrown to the
  // server-wide handler: throttling is decided before any credential is looked
  // at, so it is not a failed attempt.
  app.setErrorHandler(async (error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 400 && status < 500 && !isRateLimited(error)) {
      return refuseMalformedAttempt(request, reply);
    }
    throw error;
  });

  app.post("/session", async (request, reply) => {
    const attempt = parseAttempt(request.body);
    if (attempt === null) {
      return refuseMalformedAttempt(request, reply);
    }
    const { credentials, form } = attempt;

    const verification = await verifyCredentials(database, credentials);
    if (!verification.verified) {
      request.log.info("refused: authentication failed");
      // Made whether or not an account was named, so the two cost the same.
      await recordAttempt(database, { userAccountId: verification.userAccountId, succeeded: false });
      return refuse(reply);
    }

    const { account } = verification;
    const session = await withTransaction(database, async (transaction) => {
      const started = await startSession(transaction, account);
      await recordAttempt(transaction, { userAccountId: account.id, succeeded: true });
      return started;
    });
    const expiresAt = session.expiresAt.toISOString();
    reply.status(201).header("cache-control", "no-store");
    if (form === "bearer") {
      return reply.send({ token: session.token, expiresAt });
    }
    // The token goes only where page script cannot read it (ADR-0004).
    return reply.header("set-cookie", sessionCookie(session.token)).send({ expiresAt });
  });

  app.get("/session", async (request, reply) => {
    const { account, failure } = await authenticator.authenticate(request);
    if (account === null) {
      request.log.info({ reason: failure, url: request.url }, "refused");
      return refuse(reply);
    }
    return reply.status(200).send({ account });
  });

  app.delete("/session", async (request, reply) => {
    const ended = await authenticator.endSession(request);
    // Ending a session nobody holds is refused like any other request without one.
    if (ended === null) {
      return refuse(reply);
    }
    if (ended === "cookie") {
      reply.header("set-cookie", EXPIRED_SESSION_COOKIE);
    }
    return reply.status(204).send();
  });
}

export function registerAuthenticationRoutes(app: FastifyInstance, options: AuthenticationOptions): void {
  app.register(authenticationRoutes, options);
}
