import type { FastifyInstance } from "fastify";
import type { RefusalReason } from "../access/index.ts";
import {
  createUserAccount,
  findUserAccount,
  fromPublicOrigin,
  parseCredentials,
  startBrowserSession,
  type Authenticator,
  type UserAccount,
} from "../authentication/index.ts";
import { appendAuditRecord, recordRefusal } from "../audit/index.ts";
import type { PublicOrigin } from "../config.ts";
import type { Database } from "../db/pool.ts";
import { withTransaction, type Queryable } from "../db/transaction.ts";
import { refuse } from "../http/refusal.ts";
import { findSchool, personFor } from "./index.ts";
import {
  findInvitation,
  findInvitationBySecretHash,
  hashSecret,
  invitationState,
  invitationTime,
  redeemInvitationFor,
  type Invitation,
} from "./invitations.ts";

// A secret is 43 characters of base64url (SECRET_BYTES in invitations.ts).
// This only keeps a body of nonsense from being hashed and queried; it is not
// itself a validity check, which the hash lookup below already is.
const MAX_SECRET_LENGTH = 512;

function parseSecret(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const { secret } = body as Record<string, unknown>;
  return typeof secret === "string" && secret.length > 0 && secret.length <= MAX_SECRET_LENGTH ? secret : null;
}

/** Why a secret that matched a real Invitation is refused, once it is no longer pending. */
function endedReason(invitation: Invitation, now: Date): "revoked" | "redeemed" | "expired" | null {
  const state = invitationState(invitation, now);
  return state === "pending" ? null : state;
}

/**
 * Records a refusal in the Invitation's own School, exactly as the
 * School-scoped chokepoint in http/school-scope.ts does for an authenticated
 * request: same `recordRefusal`, same `access.refused` action. There is no
 * Person to name as Actor, only the account when a session presented one.
 */
async function auditInvitationRefusal(
  database: Queryable,
  invitation: Invitation,
  reason: RefusalReason,
  account: UserAccount | null = null,
): Promise<void> {
  await recordRefusal(database, {
    schoolId: invitation.schoolId,
    actorPersonId: null,
    actorPlatformAdministratorId: null,
    userAccountId: account?.id ?? null,
    reason,
    target: { type: "invitation", id: invitation.id },
  });
}

type SecretLookup = { invitation: Invitation } | { refused: true };

/**
 * The pending Invitation a secret names. A secret matching nothing is logged
 * only: there is no School to hold a record of an attempt against nothing.
 * One matching an Invitation that has since ended is audited in that
 * Invitation's School with the true reason (spec #74).
 */
async function pendingInvitationFor(database: Queryable, secret: string): Promise<SecretLookup> {
  const invitation = await findInvitationBySecretHash(database, hashSecret(secret));
  if (invitation === null) {
    return { refused: true };
  }
  const reason = endedReason(invitation, await invitationTime(database));
  if (reason !== null) {
    await auditInvitationRefusal(database, invitation, reason);
    return { refused: true };
  }
  return { invitation };
}

const USERNAME_UNAVAILABLE = { status: "username_unavailable" } as const;

const POSTGRES_UNIQUE_VIOLATION = "23505";

/** Whether an insert failed because of `app.user_account_username_key`. */
function isUsernameTaken(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === POSTGRES_UNIQUE_VIOLATION;
}

/** `app.person`'s guarantee that an account resolves to at most one Person per School. */
const PERSON_PER_SCHOOL_CONSTRAINT = "person_school_id_user_account_id_key";

function violates(error: unknown, constraint: string): boolean {
  const { code, constraint: violated } = (error ?? {}) as { code?: string; constraint?: string };
  return code === POSTGRES_UNIQUE_VIOLATION && violated === constraint;
}

/** Thrown when another request redeemed, revoked, or outlasted the Invitation first. */
class InvitationClaimedElsewhere extends Error {}

/** Throws InvitationClaimedElsewhere when the Invitation stopped being pending first, so the transaction rolls back. */
async function attach(transaction: Queryable, invitation: Invitation, account: UserAccount): Promise<void> {
  if ((await redeemInvitationFor(transaction, { invitation, account })) === null) {
    throw new InvitationClaimedElsewhere();
  }
  await appendAuditRecord(transaction, {
    schoolId: invitation.schoolId,
    actorPersonId: invitation.person.id,
    action: "invitation.redeemed",
    target: { type: "invitation", id: invitation.id },
    reason: null,
    before: null,
    after: { userAccountId: account.id },
  });
}

/** Audits why an Invitation that was pending when looked up was no longer so when attached. */
async function auditClaimedElsewhere(database: Queryable, invitation: Invitation): Promise<void> {
  const current = (await findInvitation(database, invitation.id))!;
  const reason = endedReason(current, await invitationTime(database)) ?? "redeemed";
  await auditInvitationRefusal(database, current, reason);
}

/**
 * Inspecting and redeeming an Invitation, addressed by its secret rather than
 * by School: the caller is known by the secret they hold, not by a Person in
 * any School. Not School-scoped, so no route here reaches
 * http/school-scope.ts; each decides for itself what to audit and what to
 * refuse (ADR-0002).
 */
export function registerInvitationRedemptionRoutes(
  app: FastifyInstance,
  database: Database,
  authenticator: Authenticator,
  publicOrigin: PublicOrigin,
): void {
  // Reveals only a School's name and a Person's display name, and nothing
  // else about either: not their identifiers, and nothing about the
  // Invitation itself.
  app.post("/invitations/inspect", async (request, reply) => {
    const secret = parseSecret(request.body);
    if (secret === null) {
      request.log.info("refused: malformed invitation secret");
      return refuse(reply);
    }
    const found = await pendingInvitationFor(database, secret);
    if ("refused" in found) {
      request.log.info("refused: invitation not available");
      return refuse(reply);
    }
    const school = (await findSchool(database, found.invitation.schoolId))!;
    return reply.status(200).send({
      school: { name: school.name },
      person: { displayName: found.invitation.person.displayName },
    });
  });

  app.post("/invitations/redeem", async (request, reply) => {
    const secret = parseSecret(request.body);
    const credentials = parseCredentials(request.body);
    if (secret === null || credentials === null) {
      request.log.info("refused: malformed invitation redemption");
      return refuse(reply);
    }
    const found = await pendingInvitationFor(database, secret);
    if ("refused" in found) {
      return refuse(reply);
    }
    const { invitation } = found;

    // A cookie set from another site would sign the victim's browser into the
    // attacker's own account, exactly as a cross-origin sign-in would
    // (ADR-0004), so this is refused and audited like any other redemption
    // refusal, not treated as a field the caller could learn anything from.
    if (!fromPublicOrigin(request, publicOrigin)) {
      request.log.info("refused: cross-origin invitation redemption");
      await auditInvitationRefusal(database, invitation, "cross-origin");
      return refuse(reply);
    }

    // The one field-level message in the whole flow (spec #74): reachable
    // only once the secret names a pending Invitation, and leaves it pending
    // either way. The insert below is still guarded against a concurrent
    // registration of the same username that lands between this check and it.
    if ((await findUserAccount(database, credentials.username)) !== null) {
      return reply.status(409).send(USERNAME_UNAVAILABLE);
    }

    try {
      const session = await withTransaction(database, async (transaction) => {
        const account = await createUserAccount(transaction, credentials);
        await attach(transaction, invitation, account);
        return startBrowserSession(transaction, account);
      });
      return reply.status(201).header("set-cookie", session.cookie).send({ expiresAt: session.expiresAt });
    } catch (error) {
      if (isUsernameTaken(error)) {
        return reply.status(409).send(USERNAME_UNAVAILABLE);
      }
      if (!(error instanceof InvitationClaimedElsewhere)) {
        throw error;
      }
      await auditClaimedElsewhere(database, invitation);
      return refuse(reply);
    }
  });

  // The caller already holds a session, so none is started: they stay signed
  // in as they were, and a Bearer client keeps presenting its token.
  app.post("/invitations/redeem-signed-in", async (request, reply) => {
    const secret = parseSecret(request.body);
    if (secret === null) {
      request.log.info("refused: malformed invitation redemption");
      return refuse(reply);
    }
    const found = await pendingInvitationFor(database, secret);
    if ("refused" in found) {
      return refuse(reply);
    }
    const { invitation } = found;

    // Covers the Origin check on a cookie session too (#76): authenticate
    // reports a cross-origin change before it looks the session up.
    const { account, failure } = await authenticator.authenticate(request);
    if (account === null) {
      request.log.info({ reason: failure }, "refused: invitation redemption without a session");
      await auditInvitationRefusal(database, invitation, failure);
      return refuse(reply);
    }

    // One account resolves to at most one Person per School (ADR-0001). The
    // Invitation stays pending, and the refusal is audited so a School
    // Administrator can find the duplicate Person (CONTEXT.md, Invitation).
    if ((await personFor(database, { userAccountId: account.id, schoolId: invitation.schoolId })) !== null) {
      request.log.info("refused: account already has a Person in the invitation's school");
      await auditInvitationRefusal(database, invitation, "duplicate-person", account);
      return refuse(reply);
    }

    try {
      await withTransaction(database, (transaction) => attach(transaction, invitation, account));
      return reply.status(204).send();
    } catch (error) {
      // The same account attached to another Person in this School between the
      // check above and the attach, through a second Invitation redeemed at once.
      if (violates(error, PERSON_PER_SCHOOL_CONSTRAINT)) {
        request.log.info("refused: account already has a Person in the invitation's school");
        await auditInvitationRefusal(database, invitation, "duplicate-person", account);
        return refuse(reply);
      }
      if (!(error instanceof InvitationClaimedElsewhere)) {
        throw error;
      }
      await auditClaimedElsewhere(database, invitation);
      return refuse(reply);
    }
  });
}
