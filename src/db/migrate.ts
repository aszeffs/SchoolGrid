import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Database } from "./pool.ts";

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

export async function migrate(db: Database): Promise<MigrationResult> {
  const migrations = await readMigrations();

  await db.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await db.query<{ name: string; checksum: string }>(
    "SELECT name, checksum FROM public.schema_migrations",
  );
  const recorded = new Map(rows.map((row) => [row.name, row.checksum]));

  const result: MigrationResult = { applied: [], alreadyApplied: [] };

  for (const migration of migrations) {
    const existing = recorded.get(migration.name);

    if (existing !== undefined) {
      // An applied migration whose file has since changed means the database
      // and the repository disagree about what was run. Refuse rather than
      // guess which one is right.
      if (existing !== migration.checksum) {
        throw new Error(
          `Migration ${migration.name} was already applied but its contents have changed. ` +
            `Add a new migration instead of editing an applied one.`,
        );
      }
      result.alreadyApplied.push(migration.name);
      continue;
    }

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
