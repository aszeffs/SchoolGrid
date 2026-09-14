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
  /** What happened, as `<subject>.<verb>`, such as `school.provisioned`. */
  action: string;
  target: { type: string; id: string | null };
  reason: string | null;
  before: AuditValues | null;
  after: AuditValues | null;
}

/** An entry as it was recorded. The database, not the caller, sets when. */
export interface AuditRecord extends Omit<AuditEntry, "schoolId"> {
  id: string;
  occurredAt: string;
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
       (school_id, actor_person_id, action, target_type, target_id, reason, before_value, after_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.schoolId,
      entry.actorPersonId,
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
 * One School's trail, newest first. Whether the caller may read it is the
 * Access module's decision, made before this is reached.
 */
export async function readAuditRecords(
  database: Queryable,
  schoolId: string,
): Promise<AuditRecord[]> {
  const { rows } = await database.query<{
    id: string;
    occurred_at: Date;
    actor_person_id: string | null;
    action: string;
    target_type: string;
    target_id: string | null;
    reason: string | null;
    before_value: AuditValues | null;
    after_value: AuditValues | null;
  }>(
    `SELECT id, occurred_at, actor_person_id, action, target_type, target_id, reason,
            before_value, after_value
     FROM app.audit_record
     WHERE school_id = $1
     ORDER BY position DESC`,
    [schoolId],
  );
  return rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    actorPersonId: row.actor_person_id,
    action: row.action,
    target: { type: row.target_type, id: row.target_id },
    reason: row.reason,
    before: row.before_value,
    after: row.after_value,
  }));
}
