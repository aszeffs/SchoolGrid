import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, loadMigrationConfig } from "../src/config.ts";

describe("loadConfig database connections", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://runtime:password@localhost:5432/schoolgrid");
    vi.stubEnv("MIGRATION_DATABASE_URL", "postgres://owner:password@localhost:5432/schoolgrid");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads the application's connection and the migration connection separately", () => {
    expect(loadConfig()).toMatchObject({
      databaseUrl: "postgres://runtime:password@localhost:5432/schoolgrid",
      migrationDatabaseUrl: "postgres://owner:password@localhost:5432/schoolgrid",
    });
  });

  it.each(["DATABASE_URL", "MIGRATION_DATABASE_URL"])("refuses to start without %s", (name) => {
    vi.stubEnv(name, undefined);

    expect(() => loadConfig()).toThrow(`Missing required environment variable: ${name}`);
  });

  it("migrates with the migration connection alone", () => {
    vi.stubEnv("DATABASE_URL", undefined);

    expect(loadMigrationConfig()).toEqual({
      migrationDatabaseUrl: "postgres://owner:password@localhost:5432/schoolgrid",
    });
  });
});

describe("loadConfig rate limit", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://user:password@localhost:5432/schoolgrid");
    vi.stubEnv("MIGRATION_DATABASE_URL", "postgres://owner:password@localhost:5432/schoolgrid");
    vi.stubEnv("RATE_LIMIT_MAX", undefined);
    vi.stubEnv("RATE_LIMIT_WINDOW_MS", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows 100 requests a minute per client when nothing is set", () => {
    expect(loadConfig().rateLimit).toEqual({ max: 100, windowMs: 60_000 });
  });

  it("reads the limit from the environment", () => {
    vi.stubEnv("RATE_LIMIT_MAX", "20");
    vi.stubEnv("RATE_LIMIT_WINDOW_MS", "1000");

    expect(loadConfig().rateLimit).toEqual({ max: 20, windowMs: 1000 });
  });

  it.each(["0", "-5", "1.5", "lots", ""])("refuses to start with RATE_LIMIT_MAX=%j", (value) => {
    vi.stubEnv("RATE_LIMIT_MAX", value);

    expect(() => loadConfig()).toThrow(/RATE_LIMIT_MAX must be a positive integer/);
  });

  it("refuses to start with a window that is not a positive integer", () => {
    vi.stubEnv("RATE_LIMIT_WINDOW_MS", "0");

    expect(() => loadConfig()).toThrow(/RATE_LIMIT_WINDOW_MS must be a positive integer/);
  });
});
