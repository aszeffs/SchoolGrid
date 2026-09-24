import type { Actor } from "../access/index.ts";
import { appendAuditRecord, type AuditValues } from "../audit/index.ts";
import type { Queryable } from "../db/transaction.ts";
import type { Changed } from "./index.ts";

/** How one kind of record this module changes is named and written in the Audit record. */
export interface RecordKind<T> {
  type: string;
  values: (record: T) => AuditValues;
}

/**
 * Records one change to one of this module's records, in the transaction that
 * makes it: its creation, change, or deletion, with its values before and
 * after.
 */
export async function recordChange<T extends { id: string }>(
  transaction: Queryable,
  actor: Actor,
  { type, values }: RecordKind<T>,
  { before, after }: Changed<T>,
  reason: string | null,
): Promise<void> {
  await appendAuditRecord(transaction, {
    schoolId: actor.schoolId,
    actorPersonId: actor.person.id,
    action: `${type}.${before === null ? "created" : after === null ? "deleted" : "changed"}`,
    target: { type, id: (after ?? before)!.id },
    reason,
    before: before === null ? null : values(before),
    after: after === null ? null : values(after),
  });
}
