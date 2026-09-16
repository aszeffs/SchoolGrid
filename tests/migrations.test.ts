import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.ts";
import { useTestServer } from "./support/harness.ts";

describe("migrations", () => {
  const server = useTestServer();

  it("creates the app schema", async () => {
    const { rows } = await server().database.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'app') AS exists",
    );

    expect(rows[0]?.exists).toBe(true);
  });

  // Migrations run as the schema owner, never as the application's role.
  it("is repeatable: re-running applies nothing", async () => {
    const result = await migrate(server().ownerDatabase);

    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toContain("0001_initial.sql");
  });

  it("refuses to run when an applied migration's contents have changed", async () => {
    await server().ownerDatabase.query(
      "UPDATE public.schema_migrations SET checksum = 'tampered' WHERE name = '0001_initial.sql'",
    );

    await expect(migrate(server().ownerDatabase)).rejects.toThrow(/contents have changed/);
  });

  describe("normalising usernames", () => {
    const MIGRATION = "0009_normalised_usernames.sql";

    // Returns the database to where it stood before the migration, when
    // uniqueness was only by lower case, so accounts it would merge can exist.
    async function undoMigration() {
      const owner = server().ownerDatabase;
      await owner.query(`DROP INDEX app.user_account_username_key`);
      await owner.query(`DROP FUNCTION app.username_key(text)`);
      await owner.query(
        `CREATE UNIQUE INDEX user_account_username_key ON app.user_account (lower(username))`,
      );
      await owner.query(`DELETE FROM public.schema_migrations WHERE name = $1`, [MIGRATION]);
    }

    async function usernames() {
      const { rows } = await server().ownerDatabase.query<{ username: string }>(
        `SELECT username FROM app.user_account ORDER BY username`,
      );
      return rows.map((row) => row.username);
    }

    it("applies to accounts that do not collide", async () => {
      await undoMigration();
      await server().createAccount({ username: "alice", password: "a staple" });
      await server().createAccount({ username: "élodie", password: "a staple" });

      const result = await migrate(server().ownerDatabase);

      expect(result.applied).toEqual([MIGRATION]);
    });

    it("refuses to apply, and merges nothing, when existing accounts would collide", async () => {
      await undoMigration();
      await server().createAccount({ username: "rené", password: "a staple" });
      await server().createAccount({ username: "rené", password: "a staple" });
      await server().createAccount({ username: "alice", password: "a staple" });
      const before = await usernames();

      await expect(migrate(server().ownerDatabase)).rejects.toThrow(/collide/);

      expect(await usernames()).toEqual(before);
      const { rows } = await server().ownerDatabase.query(
        `SELECT 1 FROM public.schema_migrations WHERE name = $1`,
        [MIGRATION],
      );
      expect(rows).toEqual([]);
    });
  });
});
