import { describe, expect, it } from "vitest";
import { useTestServer } from "./support/harness.ts";

describe("test harness", () => {
  const server = useTestServer();

  it("runs against a real Postgres, not a substitute", async () => {
    const { rows } = await server().database.query<{ version: string }>("SELECT version()");

    expect(rows[0]?.version).toMatch(/PostgreSQL/);
  });

  it("starts each test from the migrated template", async () => {
    const { rows } = await server().database.query<{ name: string }>(
      "SELECT name FROM public.schema_migrations ORDER BY name",
    );

    expect(rows.map((row) => row.name)).toContain("0001_initial.sql");
  });

  // The two tests below are a pair: the first writes, the second proves it
  // cannot see the write. If isolation ever breaks, the second fails.
  it("isolation, part one: writes data into its own database", async () => {
    await server().database.query("CREATE TABLE app.isolation_probe (marker text PRIMARY KEY)");
    await server().database.query("INSERT INTO app.isolation_probe VALUES ('written-by-part-one')");

    const { rowCount } = await server().database.query("SELECT * FROM app.isolation_probe");
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
});
