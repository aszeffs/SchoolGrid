import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "../db/transaction.ts";
import type { Person } from "./index.ts";

/**
 * Invitations as stored. Each is one School Administrator's offer to let the
 * human behind one unclaimed Person attach it to a User account. A row is never
 * deleted: it ends by being revoked or redeemed, or lapses when it expires, and
 * stays as the record of what was offered (migrations/0010).
 *
 * Nothing here decides whether anyone may issue, see, or revoke one: that is
 * the Access module's decision, made before any of this is reached.
 */
export interface Invitation {
  id: string;
  schoolId: string;
  person: Pick<Person, "id" | "displayName">;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  redeemedAt: Date | null;
}

export type InvitationState = "pending" | "revoked" | "redeemed" | "expired";

const SECRET_BYTES = 32;

const INVITATION_COLUMNS = `invitation.id, invitation.school_id AS "schoolId",
  json_build_object('id', person.id, 'displayName', person.display_name) AS person,
  invitation.created_at AS "issuedAt", invitation.expires_at AS "expiresAt",
  invitation.revoked_at AS "revokedAt", invitation.redeemed_at AS "redeemedAt"`;

const INVITATION_FROM = `app.invitation invitation
  JOIN app.person person ON person.school_id = invitation.school_id AND person.id = invitation.person_id`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether the Invitation row aliased `alias` is pending as this statement runs.
 * Statement time rather than transaction time: see migrations/0010.
 */
function isPending(alias: string): string {
  return `${alias}.revoked_at IS NULL AND ${alias}.redeemed_at IS NULL
    AND ${alias}.expires_at > statement_timestamp()`;
}

function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

/**
 * Where an Invitation stands at this moment. Expiry is read from the clock and
 * never written down: see migrations/0010.
 */
export function invitationState(invitation: Invitation, now: Date): InvitationState {
  if (invitation.revokedAt !== null) {
    return "revoked";
  }
  if (invitation.redeemedAt !== null) {
    return "redeemed";
  }
  return invitation.expiresAt > now ? "pending" : "expired";
}

/**
 * Issues an Invitation for a Person, and returns it with its secret. The secret
 * is returned here and nowhere else, ever: only its hash is stored, so nothing
 * read back later can recover it.
 *
 * The Person must hold no pending Invitation, or the database refuses the
 * insert: revoke that one first, in the same transaction.
 */
export async function issueInvitation(
  transaction: Queryable,
  { person, issuedBy }: { person: Person; issuedBy: Person },
): Promise<{ invitation: Invitation; secret: string }> {
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const { rows } = await transaction.query<{ id: string }>(
    `INSERT INTO app.invitation (school_id, person_id, issued_by_person_id, secret_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [person.schoolId, person.id, issuedBy.id, hashSecret(secret)],
  );
  const invitation = await findInvitation(transaction, rows[0]!.id);
  return { invitation: invitation!, secret };
}

/**
 * The moment against which a locked Invitation is judged pending. Taken once the
 * lock is held, for the reason given at migrations/0010.
 */
export async function invitationTime(transaction: Queryable): Promise<Date> {
  const { rows } = await transaction.query<{ now: Date }>("SELECT statement_timestamp() AS now");
  return rows[0]!.now;
}

/** The Invitation with this identifier, in whichever School holds it, or null. */
export async function findInvitation(database: Queryable, invitationId: string): Promise<Invitation | null> {
  if (!UUID.test(invitationId)) {
    return null;
  }
  const { rows } = await database.query<Invitation>(
    `SELECT ${INVITATION_COLUMNS} FROM ${INVITATION_FROM} WHERE invitation.id = $1`,
    [invitationId],
  );
  return rows[0] ?? null;
}

/**
 * Locks an Invitation until the transaction ends, so two changes to it cannot
 * interleave, and returns it as it now stands.
 *
 * Only for an Invitation the caller has already been permitted to change, for
 * the reason given at lockMembership.
 */
export async function lockInvitation(transaction: Queryable, invitation: Invitation): Promise<Invitation> {
  const { rows } = await transaction.query<Invitation>(
    `SELECT ${INVITATION_COLUMNS} FROM ${INVITATION_FROM}
     WHERE invitation.school_id = $1 AND invitation.id = $2
     FOR UPDATE OF invitation`,
    [invitation.schoolId, invitation.id],
  );
  return rows[0]!;
}

/** Every pending Invitation in the School, soonest to expire first. */
export async function pendingInvitationsInSchool(database: Queryable, schoolId: string): Promise<Invitation[]> {
  const { rows } = await database.query<Invitation>(
    `SELECT ${INVITATION_COLUMNS} FROM ${INVITATION_FROM}
     WHERE invitation.school_id = $1
       AND ${isPending("invitation")}
     ORDER BY invitation.expires_at, invitation.id`,
    [schoolId],
  );
  return rows;
}

/** The Person's pending Invitation, locked until the transaction ends, or null. */
export async function lockPendingInvitationFor(transaction: Queryable, person: Person): Promise<Invitation | null> {
  const { rows } = await transaction.query<Invitation>(
    `SELECT ${INVITATION_COLUMNS} FROM ${INVITATION_FROM}
     WHERE invitation.school_id = $1 AND invitation.person_id = $2
       AND ${isPending("invitation")}
     FOR UPDATE OF invitation`,
    [person.schoolId, person.id],
  );
  return rows[0] ?? null;
}

/** Revokes an Invitation now. Whether it is still pending is the caller's to have decided. */
export async function revokeInvitation(
  transaction: Queryable,
  invitation: Invitation,
  revokedBy: Person,
): Promise<Invitation> {
  await transaction.query(
    `UPDATE app.invitation SET revoked_at = statement_timestamp(), revoked_by_person_id = $3
     WHERE school_id = $1 AND id = $2`,
    [invitation.schoolId, invitation.id, revokedBy.id],
  );
  return (await findInvitation(transaction, invitation.id))!;
}
