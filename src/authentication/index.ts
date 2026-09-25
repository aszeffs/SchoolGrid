import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PublicOrigin } from "../config.ts";
import type { Database } from "../db/pool.ts";
import { withTransaction, type Queryable } from "../db/transaction.ts";
import { isRateLimited } from "../http/rate-limit.ts";
import { refuse } from "../http/refusal.ts";
import { MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH } from "../validation/bounds.ts";
import { hashPassword, spendVerificationEffort, verifyPassword } from "./passwords.ts";
import {
  carriesSessionCookie,
  EXPIRED_SESSION_COOKIE,
  fromPublicOrigin,
  presentedSession,
  sessionCookie,
  type AuthenticationFailure,
  type SessionForm,
} from "./presented-session.ts";

export { fromPublicOrigin, type AuthenticationFailure } from "./presented-session.ts";

/**
 * The Authentication module answers one question for the rest of the system:
 * which User account, if any, does this request belong to.
 *
 * A User account is credentials and authentication state. Nothing here knows
 * about Schools, Persons, roles, or permissions, and nothing exported from
 * here may return one. Resolving an account to a Person is Identity's job.
 *
 * One exception, and only to what it reads (ADR-0012): an account remembers
 * the School it was created in, and a Session is not live once that School is
 * a Trial School past its expiry. Which School that is, and what it holds,
 * this module still never answers.
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

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/**
 * Creates an account that signs in with these credentials. One created inside
 * a School, as redeeming an Invitation creates one, names it: an account
 * created in a Trial School is deleted with it, and holds no live Session
 * once it has expired (ADR-0012).
 */
export async function createUserAccount(
  database: Queryable,
  { username, password }: Credentials,
  { createdInSchoolId = null }: { createdInSchoolId?: string | null } = {},
): Promise<UserAccount> {
  const { rows } = await database.query<UserAccount>(
    `INSERT INTO app.user_account (username, password_hash, created_in_school_id)
     VALUES ($1, $2, $3)
     RETURNING id, username`,
    [username, await hashPassword(password), createdInSchoolId],
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
  const { rows } = await database.query<UserAccount & { password_hash: string | null }>(
    `SELECT id, username, password_hash FROM app.user_account
     WHERE app.username_key(username) = app.username_key($1)`,
    [username],
  );
  const account = rows[0];

  if (account === undefined) {
    await spendVerificationEffort(password);
    return { verified: false, userAccountId: null };
  }
  // A Trial School's role account, which no password verifies. It costs what a
  // wrong password costs, so it cannot be told apart by timing either.
  if (account.password_hash === null) {
    await spendVerificationEffort(password);
    return { verified: false, userAccountId: account.id };
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
async function deleteSession(database: Queryable, token: string): Promise<boolean> {
  const { rowCount } = await database.query(
    `DELETE FROM app.user_session WHERE token_hash = $1 AND expires_at > now()`,
    [hashToken(token)],
  );
  return rowCount !== null && rowCount > 0;
}

/**
 * Starts a session and returns it ready to set as a browser's cookie
 * (ADR-0004), for a caller elsewhere in the system that signs a browser in
 * without going through sign-in itself, such as redeeming an Invitation.
 */
export async function startBrowserSession(
  transaction: Queryable,
  account: UserAccount,
): Promise<{ cookie: string; expiresAt: string }> {
  const { token, expiresAt } = await startSession(transaction, account);
  return { cookie: sessionCookie(token), expiresAt: expiresAt.toISOString() };
}

/** The account a request belongs to, or why it belongs to none. */
export type Authentication =
  | { account: UserAccount; failure?: never }
  | { account: null; failure: AuthenticationFailure };

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
   * Ends the live Session the request presents, and says what the reply owes
   * the caller: see SessionEnding.
   */
  endSession(request: FastifyRequest): Promise<SessionEnding>;
  /**
   * Within the transaction, ends the live Session the request presents and
   * starts a browser Session for another account in its place, as a Trial
   * School does when its visitor changes role. Null, starting nothing, when
   * the request presents no live Session to end.
   */
  replaceSession(
    transaction: Queryable,
    request: FastifyRequest,
    account: UserAccount,
  ): Promise<{ cookie: string; expiresAt: string } | null>;
}

/**
 * What ending a Session leaves the sign-out route to send: whether one was
 * ended, or why none was, and the cookie to expire, if any.
 *
 * The two are decided separately on purpose. Whether a Session ended follows
 * from whether one was live; whether a cookie is expired follows only from the
 * caller's own request carrying one from the public origin. A cookie nothing
 * is behind is still the caller's to clear.
 */
export type SessionEnding = {
  /** The cookie that expires the one the request carried, or null to send none. */
  expiringCookie: string | null;
} & (
  | { ended: true; failure?: never }
  /** Why nothing was ended. Never reaches the caller (ADR-0002); logged only. */
  | { ended: false; failure: AuthenticationFailure }
);

/** An Authenticator for SchoolGrid served at `publicOrigin`. */
export function createAuthenticator(database: Database, publicOrigin: PublicOrigin): Authenticator {
  return {
    async authenticate(request) {
      const presented = presentedSession(request, publicOrigin);
      if (presented.failure !== undefined) {
        return { account: null, failure: presented.failure };
      }
      if (presented.token === null) {
        return { account: null, failure: "unauthenticated" };
      }
      // An account created in a Trial School holds no live Session once that
      // School has expired, so access ends on the minute (ADR-0012). Only when
      // it was: the School is otherwise nothing this module knows about.
      const { rows } = await database.query<UserAccount>(
        `SELECT account.id, account.username
         FROM app.user_session session
         JOIN app.user_account account ON account.id = session.user_account_id
         LEFT JOIN app.school created_in ON created_in.id = account.created_in_school_id
         WHERE session.token_hash = $1 AND session.expires_at > now()
           AND (created_in.trial_expires_at IS NULL OR created_in.trial_expires_at > now())`,
        [hashToken(presented.token)],
      );
      const account = rows[0];
      return account === undefined ? { account: null, failure: "unauthenticated" } : { account };
    },

    async endSession(request) {
      const presented = presentedSession(request, publicOrigin);
      // Asked of the request directly rather than read off `presented`: the
      // ambiguity check short-circuits before the Origin check, so an
      // ambiguous request never reaches it, yet its cookie is still the
      // caller's own. Expiring it only for the public origin keeps a
      // cross-site request from having any effect on the Session (ADR-0004).
      const expiringCookie =
        carriesSessionCookie(request) && fromPublicOrigin(request, publicOrigin) ? EXPIRED_SESSION_COOKIE : null;
      const refused = (failure: AuthenticationFailure): SessionEnding => ({ ended: false, failure, expiringCookie });
      if (presented.failure !== undefined) {
        return refused(presented.failure);
      }
      if (presented.token === null) {
        return refused("unauthenticated");
      }
      return (await deleteSession(database, presented.token))
        ? { ended: true, expiringCookie }
        : refused("unauthenticated");
    },

    async replaceSession(transaction, request, account) {
      const presented = presentedSession(request, publicOrigin);
      if (presented.failure !== undefined || presented.token === null) {
        return null;
      }
      if (!(await deleteSession(transaction, presented.token))) {
        return null;
      }
      return startBrowserSession(transaction, account);
    },
  };
}

/**
 * The username and password a body carries, within sign-in's own bounds,
 * ignoring any other field: reused wherever else credentials are taken
 * alongside something else, such as redeeming an Invitation with a new
 * account.
 */
export function parseCredentials(body: unknown): Credentials | null {
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
  publicOrigin: PublicOrigin;
}

async function authenticationRoutes(
  app: FastifyInstance,
  { database, authenticator, recordAttempt, publicOrigin }: AuthenticationOptions,
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
    // A sign-in from another site would put the browser in the attacker's own
    // account, so a cookie is only given to a page on the public origin. Checked
    // after the credentials, so the attempt is recorded against the account it
    // named, as any other failed attempt is. A Bearer token is not ambient, so
    // it is not guarded.
    if (form === "cookie" && !fromPublicOrigin(request, publicOrigin)) {
      request.log.info("refused: cross-origin sign-in");
      await recordAttempt(database, { userAccountId: account.id, succeeded: false });
      return refuse(reply);
    }
    const session = await withTransaction(database, async (transaction) => {
      const started = await startSession(transaction, account);
      await recordAttempt(transaction, { userAccountId: account.id, succeeded: true });
      return started;
    });
    const expiresAt = session.expiresAt.toISOString();
    // No `cache-control` of its own: every response under `/api` already carries
    // `no-store` from the security headers, and a second one here could only weaken it.
    reply.status(201);
    if (form === "bearer") {
      return reply.send({ token: session.token, expiresAt });
    }
    // The token goes only where page script cannot read it (ADR-0004).
    return reply.header("set-cookie", sessionCookie(session.token)).send({ expiresAt });
  });

  // `GET /session` is not here. It answers with the Schools, Persons and roles
  // the account reaches, which this module may not know: it is registered in
  // identity/routes.ts, where resolving an account to a Person belongs.

  app.delete("/session", async (request, reply) => {
    const { ended, failure, expiringCookie } = await authenticator.endSession(request);
    // Set first, so it rides the refusal and the 204 alike: the caller asked to
    // end their Session, and the cookie they sent goes either way.
    if (expiringCookie !== null) {
      reply.header("set-cookie", expiringCookie);
    }
    // Ending a Session nobody holds is refused like any other request without one.
    if (!ended) {
      request.log.info({ reason: failure, url: request.url }, "refused");
      return refuse(reply);
    }
    return reply.status(204).send();
  });
}

export function registerAuthenticationRoutes(app: FastifyInstance, options: AuthenticationOptions): void {
  app.register(authenticationRoutes, options);
}
