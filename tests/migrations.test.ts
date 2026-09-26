import { describe, expect, it } from "vitest";
import { assertMigrated, migrate } from "../src/db/migrate.ts";
import type { Database } from "../src/db/pool.ts";
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

    await expect(migrate(server().ownerDatabase)).rejects.toThrow(
      /contents have changed/,
    );
  });

  // Migration 0009 needs casefold() and pg_unicode_fast, which arrived in
  // PostgreSQL 18. The harness can only run 18, so an older server is faked by
  // answering the version with 17.6.
  describe("on a server older than PostgreSQL 18", () => {
    function reportingVersion(database: Database, version: string): Database {
      return new Proxy(database, {
        get(target, property, receiver) {
          if (property !== "query")
            return Reflect.get(target, property, receiver);
          return (sql: unknown, ...rest: unknown[]) =>
            (target.query as (...args: unknown[]) => unknown)(
              typeof sql === "string"
                ? sql.replace(
                    "current_setting('server_version_num')",
                    `'${version}'`,
                  )
                : sql,
              ...rest,
            );
        },
      });
    }

    it("refuses, naming the minimum and the server's version", async () => {
      await expect(
        migrate(reportingVersion(server().ownerDatabase, "170006")),
      ).rejects.toThrow(/PostgreSQL 18.*170006/);
    });

    it("changes nothing: creates no migration record and applies no migration", async () => {
      await server().ownerDatabase.query("DROP TABLE public.schema_migrations");

      await expect(
        migrate(reportingVersion(server().ownerDatabase, "170006")),
      ).rejects.toThrow(/PostgreSQL 18/);

      const { rows } = await server().ownerDatabase.query<{ exists: boolean }>(
        "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
      );
      expect(rows[0]?.exists).toBe(false);
    });
  });

  // How the service starts without the schema owner's credentials: it cannot
  // migrate, so it checks, as the application's role, that someone else did.
  describe("checking without migrating", () => {
    const LATEST = "0012_school_timezone.sql";
    const RECORD_READABLE = "0011_migration_record_readable.sql";

    it("passes, as the application's role, against a fully migrated database", async () => {
      await expect(assertMigrated(server().database)).resolves.toBeUndefined();
    });

    it("names the migration the database is missing", async () => {
      await server().ownerDatabase.query(
        "DELETE FROM public.schema_migrations WHERE name = $1",
        [LATEST],
      );

      await expect(assertMigrated(server().database)).rejects.toThrow(
        `missing migration(s) ${LATEST}`,
      );
    });

    it("names every migration of a database that was never migrated", async () => {
      await server().ownerDatabase.query("DROP TABLE public.schema_migrations");

      await expect(assertMigrated(server().database)).rejects.toThrow(
        /missing migration\(s\) 0001_initial\.sql, .*0012/,
      );
    });

    // A database migrated before 0011 has a record its application role cannot
    // read, which is the first deploy of this check. It is missing 0011, and
    // must say so rather than fail on the permission.
    it("names the migration that makes the record readable when the role cannot read it", async () => {
      await server().ownerDatabase.query(
        "REVOKE SELECT ON public.schema_migrations FROM schoolgrid_app",
      );
      await server().ownerDatabase.query(
        "DELETE FROM public.schema_migrations WHERE name >= $1",
        [RECORD_READABLE],
      );

      await expect(assertMigrated(server().database)).rejects.toThrow(
        `missing migration(s) ${RECORD_READABLE}`,
      );
    });

    it("refuses when an applied migration's contents have changed", async () => {
      await server().ownerDatabase.query(
        "UPDATE public.schema_migrations SET checksum = 'tampered' WHERE name = '0001_initial.sql'",
      );

      await expect(assertMigrated(server().database)).rejects.toThrow(
        /0001_initial\.sql .*contents have changed/,
      );
    });

    // A deploy migrates before the new image replaces the old one, so for a
    // while the old image serves a database recorded ahead of it. Every
    // migration stays compatible with the code one deploy behind it (#92).
    it("passes a database that has applied migrations this image does not know", async () => {
      await server().ownerDatabase.query(
        "INSERT INTO public.schema_migrations (name, checksum) VALUES ('9999_from_a_newer_image.sql', 'x')",
      );

      await expect(assertMigrated(server().database)).resolves.toBeUndefined();
    });

    it("applies nothing", async () => {
      await server().ownerDatabase.query(
        "DELETE FROM public.schema_migrations WHERE name = $1",
        [LATEST],
      );

      await expect(assertMigrated(server().database)).rejects.toThrow(LATEST);

      const { rows } = await server().ownerDatabase.query(
        "SELECT 1 FROM public.schema_migrations WHERE name = $1",
        [LATEST],
      );
      expect(rows).toEqual([]);
    });

    // The record is read to decide whether to start, so it must not be
    // something the application's role could rewrite to make that decision.
    it.each([
      [
        "INSERT",
        "INSERT INTO public.schema_migrations (name, checksum) VALUES ('9999_forged.sql', 'x')",
      ],
      ["UPDATE", "UPDATE public.schema_migrations SET checksum = 'x'"],
      ["DELETE", "DELETE FROM public.schema_migrations"],
      ["TRUNCATE", "TRUNCATE public.schema_migrations"],
    ])(
      "leaves the application's role unable to %s the migration record",
      async (_, sql) => {
        await expect(server().database.query(sql)).rejects.toThrow(
          /permission denied/,
        );
      },
    );
  });

  describe("giving Schools a timezone", () => {
    const MIGRATION = "0012_school_timezone.sql";

    // Returns the database to where it stood before the migration, when a
    // School had a name and nothing else.
    async function undoMigration() {
      const owner = server().ownerDatabase;
      // A later migration's trigger watches the column, so it goes first.
      await owner.query(`DROP TRIGGER school_timezone_is_fixed ON app.school`);
      await owner.query(`ALTER TABLE app.school DROP COLUMN timezone`);
      await owner.query(`DROP TABLE app.timezone`);
      await owner.query(`GRANT UPDATE, DELETE ON app.school TO schoolgrid_app`);
      await owner.query(`DELETE FROM public.schema_migrations WHERE name = $1`, [MIGRATION]);
    }

    it("gives every existing School the fixed default, UTC", async () => {
      await undoMigration();
      await server().ownerDatabase.query(`INSERT INTO app.school (name) VALUES ('Northside'), ('Westbrook')`);

      const result = await migrate(server().ownerDatabase);

      expect(result.applied).toEqual([MIGRATION]);
      const { rows } = await server().ownerDatabase.query(
        `SELECT name, timezone FROM app.school ORDER BY name`,
      );
      expect(rows).toEqual([
        { name: "Northside", timezone: "UTC" },
        { name: "Westbrook", timezone: "UTC" },
      ]);
    });

  });

  // Once no image in production creates a School by name alone (#92), every
  // School has to name its timezone.
  describe("dropping the School timezone default", () => {
    it("refuses a School created without a timezone", async () => {
      await expect(server().database.query(`INSERT INTO app.school (name) VALUES ('Eastfield')`)).rejects.toThrow(
        /null value in column "timezone"/,
      );
    });
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
      await owner.query(
        `DELETE FROM public.schema_migrations WHERE name = $1`,
        [MIGRATION],
      );
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
      await server().createAccount({
        username: "élodie",
        password: "a staple",
      });

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

  describe("removing the shared demo's School", () => {
    const MIGRATION = "0019_remove_demo_school.sql";
    // The identifier the demo's seed gave its School, as production holds it.
    const DEMO_SCHOOL_ID = "5c4001a0-0000-4000-8000-000000000001";
    const PASSWORD = "a staple";

    async function undoMigration() {
      await server().ownerDatabase.query(`DELETE FROM public.schema_migrations WHERE name = $1`, [MIGRATION]);
    }

    async function schoolsNamed() {
      const { rows } = await server().ownerDatabase.query<{ name: string }>(`SELECT name FROM app.school ORDER BY name`);
      return rows.map((row) => row.name);
    }

    it("deletes the demo School whole, its published accounts and their Sessions with it, and nothing else", async () => {
      await undoMigration();
      // A real School beside it, whose records must survive.
      const principal = await server().createAccount({ username: "principal", password: PASSWORD });
      const northside = await server().provisionSchool({ name: "Northside", administrator: principal });
      // The demo as its seed left it, and as visitors used it: accounts with a
      // Person in each role, an Enrollment, an Audit record.
      await server().ownerDatabase.query(`INSERT INTO app.school (id, name, timezone) VALUES ($1, 'Riverbend Demo School', 'UTC')`, [
        DEMO_SCHOOL_ID,
      ]);
      const administrator = await server().createAccount({ username: "demo.administrator", password: PASSWORD });
      const student = await server().createAccount({ username: "demo.student", password: PASSWORD });
      const demoAdministrator = await server().createPerson({
        schoolId: DEMO_SCHOOL_ID,
        displayName: "Morgan Reyes",
        account: administrator,
        role: "school_administrator",
      });
      await server().enroll(
        await server().createPerson({ schoolId: DEMO_SCHOOL_ID, displayName: "Jamie Lindqvist", account: student, role: "student" }),
      );
      await server().appendAuditRecord({
        schoolId: DEMO_SCHOOL_ID,
        actorPersonId: demoAdministrator.id,
        action: "person.created",
        target: { type: "person", id: demoAdministrator.id },
        reason: null,
        before: null,
        after: null,
      });
      // Someone who used the demo and belongs to a real School as well.
      const both = await server().createAccount({ username: "both", password: PASSWORD });
      await server().createPerson({ schoolId: DEMO_SCHOOL_ID, displayName: "Both", account: both, role: "faculty" });
      await server().createPerson({ schoolId: northside.school.id, displayName: "Both", account: both, role: "faculty" });
      const signedIn = await server().signIn({ username: "demo.administrator", password: PASSWORD });
      const northsideRecords = await server().ownerDatabase.query(`SELECT id FROM app.audit_record WHERE school_id = $1`, [
        northside.school.id,
      ]);

      const result = await migrate(server().ownerDatabase);

      expect(result.applied).toEqual([MIGRATION]);
      expect(await schoolsNamed()).toEqual(["Northside"]);
      // Read before signing in below, which Northside records too.
      const { rows: records } = await server().ownerDatabase.query(`SELECT id FROM app.audit_record ORDER BY position`);
      expect(records).toEqual(northsideRecords.rows);
      // Its Session is gone: it is answered as a caller with none is.
      const anonymous = await server().client.get("/api/session");
      expect((await signedIn.get("/api/session")).status).toBe(anonymous.status);
      // Its published sign-ins are answered as a username that never existed is.
      const unknown = await server().client.post("/api/session", { username: "nobody", password: PASSWORD, session: "bearer" });
      for (const username of ["demo.administrator", "demo.student"]) {
        const response = await server().client.post("/api/session", { username, password: PASSWORD, session: "bearer" });
        expect(response.status, username).toBe(unknown.status);
      }
      for (const username of ["principal", "both"]) {
        const response = await server().client.post("/api/session", { username, password: PASSWORD, session: "bearer" });
        expect(response.status, username).toBe(201);
      }
    });

    it("applies, and deletes nothing, where the demo never ran", async () => {
      await undoMigration();
      const principal = await server().createAccount({ username: "principal", password: PASSWORD });
      await server().provisionSchool({ name: "Northside", administrator: principal });

      const result = await migrate(server().ownerDatabase);

      expect(result.applied).toEqual([MIGRATION]);
      expect(await schoolsNamed()).toEqual(["Northside"]);
    });
  });
});
