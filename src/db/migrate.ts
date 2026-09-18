import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Database } from "./pool.ts";
import type { Queryable } from "./transaction.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

async function readMigrations(): Promise<Migration[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  const names = entries.filter((entry) => entry.endsWith(".sql")).sort();

  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(path.join(MIGRATIONS_DIR, name), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }),
  );
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

interface Comparison {
  pending: Migration[];
  alreadyApplied: string[];
}

/**
 * Sets the migrations in this image against the record of what the database
 * has applied. The same comparison decides what `migrate` runs and whether a
 * service that cannot migrate may start, so the two never disagree about what
 * "fully migrated" means.
 */
function compareWithRecord(migrations: Migration[], recorded: Map<string, string>): Comparison {
  const comparison: Comparison = { pending: [], alreadyApplied: [] };

  for (const migration of migrations) {
    const existing = recorded.get(migration.name);

    if (existing === undefined) {
      comparison.pending.push(migration);
      continue;
    }

    // An applied migration whose file has since changed means the database
    // and the repository disagree about what was run. Refuse rather than
    // guess which one is right.
    if (existing !== migration.checksum) {
      throw new Error(
        `Migration ${migration.name} was already applied but its contents have changed. ` +
          `Add a new migration instead of editing an applied one.`,
      );
    }
    comparison.alreadyApplied.push(migration.name);
  }

  return comparison;
}

async function readRecord(db: Queryable): Promise<Map<string, string>> {
  const { rows } = await db.query<{ name: string; checksum: string }>(
    "SELECT name, checksum FROM public.schema_migrations",
  );
  return new Map(rows.map((row) => [row.name, row.checksum]));
}

export async function migrate(db: Database): Promise<MigrationResult> {
  const migrations = await readMigrations();

  await db.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { pending, alreadyApplied } = compareWithRecord(migrations, await readRecord(db));
  const result: MigrationResult = { applied: [], alreadyApplied };

  for (const migration of pending) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(migration.sql);
      await client.query("INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)", [
        migration.name,
        migration.checksum,
      ]);
      await client.query("COMMIT");
      result.applied.push(migration.name);
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${migration.name} failed: ${(error as Error).message}`, {
        cause: error,
      });
    } finally {
      client.release();
    }
  }

  return result;
}

/** The migration that lets the application's role read the record at all. */
const RECORD_READABLE = "0011_migration_record_readable.sql";

function missingMigrations(names: string): Error {
  return new Error(
    `The database is missing migration(s) ${names}. ` +
      `Without MIGRATION_DATABASE_URL the service does not migrate; ` +
      `apply them as the schema owner first (see docs/database-roles.md).`,
  );
}

/**
 * Refuses a database that has not applied every migration in this image,
 * changing nothing. For a service started without the schema owner's
 * credentials, which cannot migrate and must not serve against a schema older
 * than its code. Reads the record as the application's role, which migration
 * 0011 lets it do.
 */
export async function assertMigrated(db: Queryable): Promise<void> {
  const migrations = await readMigrations();

  const { rows } = await db.query<{ exists: boolean; readable: boolean | null }>(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists,
            CASE WHEN to_regclass('public.schema_migrations') IS NOT NULL
                 THEN has_table_privilege('public.schema_migrations', 'SELECT')
            END AS readable`,
  );
  const { exists, readable } = rows[0]!;

  // A record this role cannot read predates the migration that grants it, so
  // that migration at least is missing. Saying so beats a permission error
  // that sends whoever reads the log looking at the wrong grant.
  if (exists && readable !== true) {
    throw missingMigrations(`${RECORD_READABLE} and any after it`);
  }

  // A database nothing ever migrated has no record at all, and is missing
  // every migration rather than broken in some other way.
  const recorded = exists ? await readRecord(db) : new Map<string, string>();

  const { pending } = compareWithRecord(migrations, recorded);
  if (pending.length > 0) {
    throw missingMigrations(pending.map((migration) => migration.name).join(", "));
  }
}
