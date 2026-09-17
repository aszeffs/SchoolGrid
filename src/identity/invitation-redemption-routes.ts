import type { FastifyInstance } from "fastify";
import {
  createUserAccount,
  findUserAccount,
  fromPublicOrigin,
  parseCredentials,
  startBrowserSession,
} from "../authentication/index.ts";
import { appendAuditRecord, recordRefusal } from "../audit/index.ts";
import type { Database } from "../db/pool.ts";
import { withTransaction, type Queryable } from "../db/transaction.ts";
import { refuse } from "../http/refusal.ts";
import { findSchool } from "./index.ts";
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
 * Actor here to name, since the human behind the secret holds no session yet.
 */
async function auditInvitationRefusal(database: Queryable, invitation: Invitation, reason: string): Promise<void> {
  await recordRefusal(database, {
    schoolId: invitation.schoolId,
    actorPersonId: null,
    actorPlatformAdministratorId: null,
    userAccountId: null,
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

/** Thrown when another request redeemed, revoked, or outlasted the Invitation first. */
class InvitationClaimedElsewhere extends Error {}

/**
 * Inspecting and redeeming an Invitation, addressed by its secret rather than
 * by School: the human behind it holds no session and belongs to no School
 * yet. Not School-scoped, so neither route reaches http/school-scope.ts;
 * each decides for itself what to audit and what to refuse (ADR-0002).
 */
export function registerInvitationRedemptionRoutes(
  app: FastifyInstance,
  database: Database,
  publicOrigin: string,
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
        const redeemed = await redeemInvitationFor(transaction, { invitation, account });
        if (redeemed === null) {
          throw new InvitationClaimedElsewhere();
        }
        const started = await startBrowserSession(transaction, account);
        await appendAuditRecord(transaction, {
          schoolId: invitation.schoolId,
          actorPersonId: invitation.person.id,
          action: "invitation.redeemed",
          target: { type: "invitation", id: invitation.id },
          reason: null,
          before: null,
          after: { userAccountId: account.id },
        });
        return started;
      });
      return reply.status(201).header("set-cookie", session.cookie).send({ expiresAt: session.expiresAt });
    } catch (error) {
      if (isUsernameTaken(error)) {
        return reply.status(409).send(USERNAME_UNAVAILABLE);
      }
      if (!(error instanceof InvitationClaimedElsewhere)) {
        throw error;
      }
      const current = (await findInvitation(database, invitation.id))!;
      const reason = endedReason(current, await invitationTime(database)) ?? "redeemed";
      await auditInvitationRefusal(database, current, reason);
      return refuse(reply);
    }
  });
}
