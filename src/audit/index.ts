import type { AuthenticationAttempt } from "../authentication/index.ts";
import type { Queryable } from "../db/transaction.ts";

/**
 * The Audit module owns Audit records. It can append one and read a School's
 * trail, and nothing else: there is no update or delete here, and none is
 * possible below it either, because the application's database role holds no
 * such grant (migrations/0004_audit_records.sql). Do not add one.
 */

/**
 * A before or after value: a flat set of scalars. Name what changed by
 * identifier. A credential, or a Student's data beyond what the entry needs,
 * does not belong in a trail that can never be erased; the database refuses a
 * key naming a credential, and refuses nesting, as a backstop.
 */
export type AuditValues = Readonly<Record<string, string | number | boolean | null>>;

export interface AuditEntry {
  /** The School whose trail this belongs to. */
  schoolId: string;
  /** The Person who acted, or null when none did. */
  actorPersonId: string | null;
  /**
   * The Platform Administrator who acted on the School from outside it, when
   * one did. Never given with a Person: an actor is one or the other.
   */
  actorPlatformAdministratorId?: string | null;
  /** What happened, as `<subject>.<verb>`, such as `school.provisioned`. */
  action: string;
  target: { type: string; id: string | null };
  reason: string | null;
  before: AuditValues | null;
  after: AuditValues | null;
}

/** An entry as it was recorded. The database, not the caller, sets when. */
export interface AuditRecord extends Omit<AuditEntry, "schoolId" | "actorPlatformAdministratorId"> {
  id: string;
  occurredAt: string;
  actorPlatformAdministratorId: string | null;
}

/**
 * Appends an entry to its School's trail.
 *
 * Pass the transaction the audited change is written in, never the pool: the
 * change and its record must commit together or not at all, so a change whose
 * record cannot be written does not happen.
 */
export async function appendAuditRecord(transaction: Queryable, entry: AuditEntry): Promise<void> {
  await transaction.query(
    `INSERT INTO app.audit_record
       (school_id, actor_person_id, actor_platform_administrator_id, action, target_type, target_id,
        reason, before_value, after_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      entry.schoolId,
      entry.actorPersonId,
      entry.actorPlatformAdministratorId ?? null,
      entry.action,
      entry.target.type,
      entry.target.id,
      entry.reason,
      entry.before,
      entry.after,
    ],
  );
}

/**
 * Records a sign-in attempt in the trail of every School where the account has
 * a Person, against that Person. A sign-in names no School, so this is how
 * each School Administrator sees attempts against their own people: the entry
 * names a Person the School already holds, and nothing about the account's
 * other Schools or what the caller typed. A failed attempt is attributed to no
 * one, since it proved nothing about who made it.
 *
 * An attempt naming no account belongs to no School and is recorded nowhere.
 * The statement still runs for it, matching nothing, so that a failure against
 * an account costs the same round trip as one against no account.
 */
export async function recordAuthenticationAttempt(
  database: Queryable,
  { userAccountId, succeeded }: AuthenticationAttempt,
): Promise<void> {
  await database.query(
    `INSERT INTO app.audit_record (school_id, actor_person_id, action, target_type, target_id)
     SELECT school_id, CASE WHEN $2::boolean THEN id END, $3, 'person', id::text
     FROM app.person
     WHERE user_account_id = $1`,
    [userAccountId, succeeded, succeeded ? "authentication.succeeded" : "authentication.failed"],
  );
}

const TARGET_ID_LIMIT = 256;

/** A refused request, as the boundary that refused it knows it. */
export interface Refusal {
  /** The School the request addressed, which may not exist or be well formed. */
  schoolId: string;
  /** The caller's Person in that School, when they had one. */
  actorPersonId: string | null;
  /** The caller as a Platform Administrator, when they were one. */
  actorPlatformAdministratorId: string | null;
  /** The caller's account, when they had one but were neither of the above. */
  userAccountId: string | null;
  reason: string;
  target: { type: string; id: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Records a refusal, with its true reason, in the trail of the School the
 * request addressed — never of the School a named record belongs to, which the
 * caller has no standing in. A School that does not exist has no trail, and
 * nothing is recorded.
 *
 * Whether the School exists is decided inside the one statement, so a refusal
 * costs the same round trip whether or not it did. The target identifier is
 * the caller's own input, and is cut to fit rather than allowed to fail the
 * write: a refusal must not turn into a different response.
 *
 * Not a transaction's companion: nothing changed, so there is nothing to
 * commit alongside it.
 */
export async function recordRefusal(database: Queryable, refusal: Refusal): Promise<void> {
  await database.query(
    `INSERT INTO app.audit_record
       (school_id, actor_person_id, actor_platform_administrator_id, action, target_type, target_id,
        reason, after_value)
     SELECT id, $2, $3, 'access.refused', $4, $5, $6, $7
     FROM app.school
     WHERE id = $1`,
    [
      // An identifier that could not name a School must not reach Postgres, which
      // would answer it with an error rather than with nothing.
      UUID.test(refusal.schoolId) ? refusal.schoolId : null,
      refusal.actorPersonId,
      refusal.actorPlatformAdministratorId,
      refusal.target.type,
      refusal.target.id.slice(0, TARGET_ID_LIMIT),
      refusal.reason,
      refusal.userAccountId === null ? null : { userAccountId: refusal.userAccountId },
    ],
  );
}

/** One page of a School's trail, and where the next begins. */
export interface AuditPage {
  auditRecords: AuditRecord[];
  /**
   * Names the last record on this page, from which the next page is read; null
   * when there is none. The record's own identifier rather than its position,
   * which counts every School's records and would let one School watch how
   * busy the others are.
   */
  nextCursor: string | null;
}

/**
 * One page of one School's trail, newest first, beginning after the record the
 * cursor names or at the newest when there is none. Whether the caller may
 * read it is the Access module's decision, made before this is reached.
 *
 * Ordered by the position a record was appended at, never by time, so the
 * order is total and stable: a record appended while someone pages is newer
 * than every cursor already issued, and lands on a first page rather than
 * shifting the pages behind it (ADR-0008).
 *
 * Null when the cursor names no record in this School's trail. A record in
 * another School's trail is looked for in this one and not found, so it is
 * answered exactly as a cursor naming nothing at all.
 */
export async function readAuditRecords(
  database: Queryable,
  schoolId: string,
  { cursor, limit }: { cursor: string | null; limit: number },
): Promise<AuditPage | null> {
  let after: string | null = null;
  if (cursor !== null) {
    const { rows } = await database.query<{ position: string }>(
      "SELECT position FROM app.audit_record WHERE school_id = $1 AND id = $2",
      [schoolId, cursor],
    );
    if (rows[0] === undefined) {
      return null;
    }
    after = rows[0].position;
  }
  const { rows } = await database.query<{
    id: string;
    occurred_at: Date;
    actor_person_id: string | null;
    actor_platform_administrator_id: string | null;
    action: string;
    target_type: string;
    target_id: string | null;
    reason: string | null;
    before_value: AuditValues | null;
    after_value: AuditValues | null;
  }>(
    `SELECT id, occurred_at, actor_person_id, actor_platform_administrator_id, action, target_type, target_id, reason,
            before_value, after_value
     FROM app.audit_record
     WHERE school_id = $1 AND ($2::bigint IS NULL OR position < $2::bigint)
     ORDER BY position DESC
     LIMIT $3`,
    // One more than the page holds, to learn whether there is a next page
    // without a second round trip.
    [schoolId, after, limit + 1],
  );
  const page = rows.slice(0, limit);
  return {
    auditRecords: page.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at.toISOString(),
      actorPersonId: row.actor_person_id,
      actorPlatformAdministratorId: row.actor_platform_administrator_id,
      action: row.action,
      target: { type: row.target_type, id: row.target_id },
      reason: row.reason,
      before: row.before_value,
      after: row.after_value,
    })),
    nextCursor: rows.length > limit ? page.at(-1)!.id : null,
  };
}
