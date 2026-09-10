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

  it("is repeatable: re-running applies nothing", async () => {
    const result = await migrate(server().database);

    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toContain("0001_initial.sql");
  });

  it("refuses to run when an applied migration's contents have changed", async () => {
    await server().database.query(
      "UPDATE public.schema_migrations SET checksum = 'tampered' WHERE name = '0001_initial.sql'",
    );

    await expect(migrate(server().database)).rejects.toThrow(/contents have changed/);
  });
});
