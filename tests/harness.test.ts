import { describe, expect, it } from "vitest";
import { useTestServer } from "./support/harness.ts";

describe("test harness", () => {
  const server = useTestServer();

  it("runs against a real Postgres, not a substitute", async () => {
    const { rows } = await server().database.query<{ version: string }>("SELECT version()");

    expect(rows[0]?.version).toMatch(/PostgreSQL/);
  });

  it("starts each test from the migrated template", async () => {
    const { rows } = await server().ownerDatabase.query<{ name: string }>(
      "SELECT name FROM public.schema_migrations ORDER BY name",
    );

    expect(rows.map((row) => row.name)).toContain("0001_initial.sql");
  });

  // The two tests below are a pair: the first writes, the second proves it
  // cannot see the write. If isolation ever breaks, the second fails.
  it("isolation, part one: writes data into its own database", async () => {
    // Creating a table is a migration's privilege, not the application's.
    const { ownerDatabase } = server();
    await ownerDatabase.query("CREATE TABLE app.isolation_probe (marker text PRIMARY KEY)");
    await ownerDatabase.query("INSERT INTO app.isolation_probe VALUES ('written-by-part-one')");

    const { rowCount } = await ownerDatabase.query("SELECT * FROM app.isolation_probe");
    expect(rowCount).toBe(1);
  });

  it("isolation, part two: cannot observe the previous test's write", async () => {
    const { rows } = await server().database.query<{ exists: boolean }>(
      "SELECT to_regclass('app.isolation_probe') IS NOT NULL AS exists",
    );

    expect(rows[0]?.exists).toBe(false);
  });

  it("gives each test a distinct database", async () => {
    const { rows } = await server().database.query<{ name: string }>(
      "SELECT current_database() AS name",
    );

    expect(rows[0]?.name).toMatch(/^test_[0-9a-f]{32}$/);
  });

  describe("arranging callers", () => {
    const ALICE = { username: "alice", password: "correct horse battery staple" };

    it("arranges an account whose password verifies at sign-in", async () => {
      await server().createAccount(ALICE);

      const response = await server().client.post("/api/session", { ...ALICE, session: "bearer" });

      expect(response.status).toBe(201);
    });

    it("hashes each password once, sharing the hash between accounts", async () => {
      await server().createAccount(ALICE);
      await server().createAccount({ username: "bob", password: ALICE.password });

      const { rows } = await server().database.query<{ password_hash: string }>(
        "SELECT DISTINCT password_hash FROM app.user_account",
      );

      expect(rows).toHaveLength(1);
    });

    it("arranges a Session the application resolves to the account, as a Bearer token or a cookie", async () => {
      const alice = await server().createAccount(ALICE);

      for (const caller of [await server().sessionFor(alice), await server().cookieSessionFor(alice)]) {
        const response = await caller.get("/api/session");

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ account: { id: alice.id, username: "alice" } });
      }
    });

    it("stores an arranged Session exactly as sign-in stores one", async () => {
      const alice = await server().createAccount(ALICE);
      await server().signIn(ALICE);
      await server().sessionFor(alice);

      // To the minute: the application's clock sets the expiry, the database's the start.
      const { rows } = await server().database.query<{ lifetimeMinutes: string; tokenBytes: number }>(
        `SELECT round(extract(epoch FROM expires_at - created_at) / 60) AS "lifetimeMinutes",
                octet_length(token_hash) AS "tokenBytes"
         FROM app.user_session WHERE user_account_id = $1`,
        [alice.id],
      );

      expect(rows).toHaveLength(2);
      expect(rows[1]).toEqual(rows[0]);
    });
  });
});
