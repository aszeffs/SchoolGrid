import {
  authorizeInvite,
  authorizeManageInvitations,
  authorizeRevokeInvitation,
  type Actor,
} from "../access/index.ts";
import { appendAuditRecord, type AuditValues } from "../audit/index.ts";
import type { Database } from "../db/pool.ts";
import { withTransaction, type Queryable } from "../db/transaction.ts";
import { InvalidRequest } from "../http/invalid-request.ts";
import { fieldsOf, reasonOnly } from "../http/request-body.ts";
import type { SchoolScope } from "../http/school-scope.ts";
import { findListedPerson, lockPerson } from "./index.ts";
import {
  findInvitation,
  invitationTime,
  issueInvitation,
  lockInvitation,
  lockPendingInvitationFor,
  pendingInvitationsInSchool,
  revokeInvitation,
  type Invitation,
} from "./invitations.ts";

/** An Invitation as served. Never its secret, which only the issuing response carries, inside the link. */
function present({ id, person, issuedAt, expiresAt }: Invitation) {
  return { id, person, issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString() };
}

/**
 * An Invitation as written to the Audit record: by identifier, with no display
 * name, and never anything derived from its secret.
 */
function valuesOf({ person, expiresAt, revokedAt }: Invitation): AuditValues {
  return {
    personId: person.id,
    expiresAt: expiresAt.toISOString(),
    revokedAt: revokedAt?.toISOString() ?? null,
  };
}

/**
 * The link a School Administrator hands to the human behind the Person. The
 * secret travels in the fragment, which a browser never sends to any server:
 * opening the link cannot write it to a request log, here or anywhere else.
 */
function linkTo(publicOrigin: string, secret: string): string {
  return `${publicOrigin}/invitation#${secret}`;
}

// Validation below runs only once the Access decision has permitted the
// caller: see InvalidRequest.

function parseIssue(body: unknown) {
  const { personId } = fieldsOf(body, ["personId"]);
  if (typeof personId !== "string" || personId.length === 0) {
    throw new InvalidRequest("personId must name a Person");
  }
  return { personId };
}

async function recordRevocation(
  transaction: Queryable,
  actor: Actor,
  {
    before,
    after,
    reason,
    supersededBy,
  }: { before: Invitation; after: Invitation; reason: string | null; supersededBy?: Invitation },
): Promise<void> {
  await appendAuditRecord(transaction, {
    schoolId: actor.schoolId,
    actorPersonId: actor.person.id,
    action: "invitation.revoked",
    target: { type: "invitation", id: after.id },
    reason,
    before: valuesOf(before),
    after: {
      ...valuesOf(after),
      ...(supersededBy === undefined ? {} : { supersededByInvitationId: supersededBy.id }),
    },
  });
}

/**
 * Invitations are issued, listed, and revoked by a School Administrator of the
 * School they belong to. Every decision is the Access module's, asked before
 * anything else about the request is looked at, and every change is recorded in
 * the transaction that makes it.
 */
export function registerInvitationRoutes(scope: SchoolScope, database: Database, publicOrigin: string): void {
  scope.get("/invitations", async (actor) => {
    const schoolId = authorizeManageInvitations(actor);
    return { invitations: (await pendingInvitationsInSchool(database, schoolId)).map(present) };
  });

  // The only response that ever carries the secret. Issuing another for the
  // same Person revokes this one, so a link lost track of is not recovered but
  // replaced.
  scope.post("/invitations", async (actor, { body }) => {
    authorizeManageInvitations(actor);
    const { personId } = parseIssue(body);
    return withTransaction(database, async (transaction) => {
      const found = authorizeInvite(actor, personId, await findListedPerson(transaction, personId));
      // Decided again once locked, so the Person cannot be claimed in between.
      const person = authorizeInvite(actor, personId, await lockPerson(transaction, found));
      const previous = await lockPendingInvitationFor(transaction, person);
      const revoked = previous === null ? null : await revokeInvitation(transaction, previous, actor.person);
      const { invitation, secret } = await issueInvitation(transaction, { person, issuedBy: actor.person });
      if (previous !== null) {
        await recordRevocation(transaction, actor, {
          before: previous,
          after: revoked!,
          reason: null,
          supersededBy: invitation,
        });
      }
      await appendAuditRecord(transaction, {
        schoolId: actor.schoolId,
        actorPersonId: actor.person.id,
        action: "invitation.issued",
        target: { type: "invitation", id: invitation.id },
        reason: null,
        before: null,
        after: valuesOf(invitation),
      });
      return { invitation: present(invitation), link: linkTo(publicOrigin, secret) };
    });
  });

  // Revoking ends an Invitation rather than deleting it: the row is the record
  // of what was offered.
  scope.delete("/invitations/:invitationId", async (actor, { params, body }) => {
    authorizeManageInvitations(actor);
    const invitationId = params["invitationId"]!;
    return withTransaction(database, async (transaction) => {
      const found = authorizeRevokeInvitation(
        actor,
        invitationId,
        await findInvitation(transaction, invitationId),
        await invitationTime(transaction),
      );
      // Decided again once locked, so two revocations cannot both succeed.
      const locked = await lockInvitation(transaction, found);
      const invitation = authorizeRevokeInvitation(actor, invitationId, locked, await invitationTime(transaction));
      const reason = reasonOnly(body);
      const revoked = await revokeInvitation(transaction, invitation, actor.person);
      await recordRevocation(transaction, actor, { before: invitation, after: revoked, reason });
      return { invitation: { ...present(revoked), revokedAt: revoked.revokedAt!.toISOString() } };
    });
  });
}
