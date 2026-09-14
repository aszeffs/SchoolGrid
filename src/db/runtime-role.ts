import type { Queryable } from "./transaction.ts";

/**
 * Refuses a connection whose role could alter the audit trail.
 *
 * The append-only guarantee is a grant the application's role lacks. An owner
 * or superuser ignores grants, so an application started with the migration
 * credentials, or any other privileged login, would run with the guarantee
 * silently void. Checked at startup, so that misconfiguration stops the
 * process instead of being discovered after a record was changed.
 */
export async function assertLeastPrivilege(database: Queryable): Promise<void> {
  const { rows } = await database.query<{ role: string; canAlter: boolean }>(
    `SELECT current_user AS role,
            has_table_privilege('app.audit_record', 'UPDATE')
              OR has_table_privilege('app.audit_record', 'DELETE')
              OR has_table_privilege('app.audit_record', 'TRUNCATE') AS "canAlter"`,
  );
  const { role, canAlter } = rows[0]!;
  if (canAlter) {
    throw new Error(
      `The database role "${role}" could update, delete, or truncate Audit records. ` +
        `DATABASE_URL must name the application's own role, not the owner or a superuser; ` +
        `see docs/database-roles.md.`,
    );
  }
}
