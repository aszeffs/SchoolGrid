import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, loadMigrationConfig } from "../src/config.ts";

describe("loadConfig database connections", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://runtime:password@localhost:5432/schoolgrid");
    vi.stubEnv("MIGRATION_DATABASE_URL", "postgres://owner:password@localhost:5432/schoolgrid");
    vi.stubEnv("PUBLIC_ORIGIN", "https://schoolgrid.example");
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

  it("refuses to start without DATABASE_URL", () => {
    vi.stubEnv("DATABASE_URL", undefined);

    expect(() => loadConfig()).toThrow("Missing required environment variable: DATABASE_URL");
  });

  // Production holds only the application's role, and does not migrate.
  it.each([undefined, ""])("starts without the migration connection when MIGRATION_DATABASE_URL is %j", (value) => {
    vi.stubEnv("MIGRATION_DATABASE_URL", value);

    const config = loadConfig();

    expect(config.databaseUrl).toBe("postgres://runtime:password@localhost:5432/schoolgrid");
    expect(config).not.toHaveProperty("migrationDatabaseUrl");
  });

  it("refuses to migrate without MIGRATION_DATABASE_URL", () => {
    vi.stubEnv("MIGRATION_DATABASE_URL", undefined);

    expect(() => loadMigrationConfig()).toThrow(
      "Missing required environment variable: MIGRATION_DATABASE_URL",
    );
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
    vi.stubEnv("PUBLIC_ORIGIN", "https://schoolgrid.example");
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

describe("loadConfig public origin", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://user:password@localhost:5432/schoolgrid");
    vi.stubEnv("MIGRATION_DATABASE_URL", "postgres://owner:password@localhost:5432/schoolgrid");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to start without PUBLIC_ORIGIN", () => {
    vi.stubEnv("PUBLIC_ORIGIN", undefined);

    expect(() => loadConfig()).toThrow("Missing required environment variable: PUBLIC_ORIGIN");
  });

  it.each([
    ["an https origin", "https://schoolgrid.example", "https://schoolgrid.example"],
    ["an https origin with a port", "https://schoolgrid.example:8443", "https://schoolgrid.example:8443"],
    ["an origin written with a trailing slash", "https://schoolgrid.example/", "https://schoolgrid.example"],
    ["an origin written in upper case", "HTTPS://SchoolGrid.Example", "https://schoolgrid.example"],
    ["http on localhost", "http://localhost:3000", "http://localhost:3000"],
    ["http on the IPv4 loopback", "http://127.0.0.1:3000", "http://127.0.0.1:3000"],
  ])("reads %s as the origin a browser sends", (_case, value, origin) => {
    vi.stubEnv("PUBLIC_ORIGIN", value);

    expect(loadConfig().publicOrigin).toBe(origin);
  });

  // A browser sends only scheme, host and port, so anything else could never
  // match; and a `Secure` cookie is not kept over plain http except on localhost.
  it.each([
    ["not a URL", "schoolgrid.example"],
    ["http off localhost", "http://schoolgrid.example"],
    ["another scheme", "ftp://schoolgrid.example"],
    ["a path", "https://schoolgrid.example/app"],
    ["a query", "https://schoolgrid.example/?next=1"],
    ["a fragment", "https://schoolgrid.example/#top"],
    ["credentials", "https://user:password@schoolgrid.example"],
  ])("refuses to start with %s", (_case, value) => {
    vi.stubEnv("PUBLIC_ORIGIN", value);

    expect(() => loadConfig()).toThrow(/PUBLIC_ORIGIN must be/);
  });
});

describe("loadConfig client address header", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://user:password@localhost:5432/schoolgrid");
    vi.stubEnv("PUBLIC_ORIGIN", "https://schoolgrid.example");
    vi.stubEnv("CLIENT_ADDRESS_HEADER", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([undefined, ""])("limits by socket address when CLIENT_ADDRESS_HEADER is %j", (value) => {
    vi.stubEnv("CLIENT_ADDRESS_HEADER", value);

    expect(loadConfig().rateLimit).not.toHaveProperty("clientAddressHeader");
  });

  it("limits by the named header, as Node names it, when one is set", () => {
    vi.stubEnv("CLIENT_ADDRESS_HEADER", "X-Vercel-Forwarded-For");

    expect(loadConfig().rateLimit.clientAddressHeader).toBe("x-vercel-forwarded-for");
  });

  // A name no request could carry would silently key every caller on the
  // socket address, which behind a proxy is one bucket for everyone.
  it.each([
    ["a space", "x forwarded for"],
    ["a colon", "x-forwarded-for:"],
    ["a trailing newline", "x-forwarded-for\n"],
    ["a non-ASCII character", "x-forwärded-for"],
    ["only whitespace", " "],
  ])("refuses to start with a header name containing %s", (_case, value) => {
    vi.stubEnv("CLIENT_ADDRESS_HEADER", value);

    expect(() => loadConfig()).toThrow(/CLIENT_ADDRESS_HEADER must be an HTTP header name/);
  });
});
