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
 * The account holding this username, matched regardless of letter case, or
 * null. For naming an account to someone permitted to name it, never for
 * deciding who a request belongs to.
 */
export async function findUserAccount(
  database: Queryable,
  username: string,
): Promise<UserAccount | null> {
  const { rows } = await database.query<UserAccount>(
    `SELECT id, username FROM app.user_account WHERE lower(username) = lower($1)`,
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
    `SELECT id, username, password_hash FROM app.user_account WHERE lower(username) = lower($1)`,
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
async function endSession(database: Database, token: string): Promise<boolean> {
  const { rowCount } = await database.query(
    `DELETE FROM app.user_session WHERE token_hash = $1 AND expires_at > now()`,
    [hashToken(token)],
  );
  return rowCount !== null && rowCount > 0;
}

function presentedToken(request: FastifyRequest): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? "");
  return match?.[1] ?? null;
}

/**
 * The User account a request belongs to, or null. A missing, malformed,
 * unrecognised, ended, or expired session all yield the same null: a stale
 * session must grant exactly what no session grants.
 */
export async function accountForRequest(
  database: Database,
  request: FastifyRequest,
): Promise<UserAccount | null> {
  const token = presentedToken(request);
  if (token === null) {
    return null;
  }

  const { rows } = await database.query<UserAccount>(
    `SELECT account.id, account.username
     FROM app.user_session session
     JOIN app.user_account account ON account.id = session.user_account_id
     WHERE session.token_hash = $1 AND session.expires_at > now()`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
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

function parseJsonOrNothing(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

interface AuthenticationOptions {
  database: Database;
  recordAttempt: RecordAttempt;
}

async function authenticationRoutes(
  app: FastifyInstance,
  { database, recordAttempt }: AuthenticationOptions,
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
    const credentials = parseCredentials(request.body);
    if (credentials === null) {
      return refuseMalformedAttempt(request, reply);
    }

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
    return reply
      .status(201)
      .header("cache-control", "no-store")
      .send({ token: session.token, expiresAt: session.expiresAt.toISOString() });
  });

  app.get("/session", async (request, reply) => {
    const account = await accountForRequest(database, request);
    if (account === null) {
      return refuse(reply);
    }
    return reply.status(200).send({ account });
  });

  app.delete("/session", async (request, reply) => {
    const token = presentedToken(request);
    // Ending a session nobody holds is refused like any other request without one.
    if (token === null || !(await endSession(database, token))) {
      return refuse(reply);
    }
    return reply.status(204).send();
  });
}

export function registerAuthenticationRoutes(
  app: FastifyInstance,
  database: Database,
  recordAttempt: RecordAttempt,
): void {
  app.register(authenticationRoutes, { database, recordAttempt });
}
