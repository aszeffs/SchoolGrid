import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, loadMigrationConfig, TRIAL_PROVIDERS } from "../src/config.ts";

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

describe("loadConfig build info", () => {
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";
  const DIGEST = `sha256:${"ab".repeat(32)}`;

  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://user:password@localhost:5432/schoolgrid");
    vi.stubEnv("PUBLIC_ORIGIN", "https://schoolgrid.example");
    vi.stubEnv("BUILD_COMMIT", undefined);
    vi.stubEnv("IMAGE_DIGEST", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads the commit baked into the image and the digest supplied at deploy", () => {
    vi.stubEnv("BUILD_COMMIT", COMMIT);
    vi.stubEnv("IMAGE_DIGEST", DIGEST);

    expect(loadConfig().buildInfo).toEqual({ commit: COMMIT, digest: DIGEST });
  });

  it.each([undefined, ""])("records neither when both are %j, as in local development", (value) => {
    vi.stubEnv("BUILD_COMMIT", value);
    vi.stubEnv("IMAGE_DIGEST", value);

    expect(loadConfig().buildInfo).toEqual({});
  });

  // Each is rendered into a link and a command a visitor runs, so anything
  // but the exact form would show them something that cannot be checked.
  it.each([
    ["an abbreviated SHA", "0123456"],
    ["upper case", COMMIT.toUpperCase()],
    ["a branch name", "main"],
    ["a trailing newline", `${COMMIT}\n`],
  ])("refuses to start with a commit that is %s", (_case, value) => {
    vi.stubEnv("BUILD_COMMIT", value);

    expect(() => loadConfig()).toThrow(/BUILD_COMMIT must be a full commit SHA/);
  });

  it.each([
    ["missing its algorithm", "ab".repeat(32)],
    ["another algorithm", `sha512:${"ab".repeat(64)}`],
    ["too short", "sha256:abcdef"],
    ["a tag", "latest"],
    ["an image reference", `ghcr.io/aszeffs/schoolgrid@${DIGEST}`],
  ])("refuses to start with a digest %s", (_case, value) => {
    vi.stubEnv("IMAGE_DIGEST", value);

    expect(() => loadConfig()).toThrow(/IMAGE_DIGEST must be a sha256 image digest/);
  });
});

describe("loadConfig trials", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://user:password@localhost:5432/schoolgrid");
    vi.stubEnv("PUBLIC_ORIGIN", "https://schoolgrid.example");
    vi.stubEnv("TRIALS_ENABLED", undefined);
    vi.stubEnv("TRIAL_LIVE_CAP", undefined);
    for (const name of PROVIDER_SETTINGS) {
      vi.stubEnv(name, undefined);
    }
    vi.stubEnv("TRIAL_IDENTITY_KEY", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const PROVIDER_SETTINGS = TRIAL_PROVIDERS.flatMap((provider) =>
    ["CLIENT_ID", "CLIENT_SECRET", "AUTHORIZE_URL", "TOKEN_URL", "USER_URL"].map(
      (setting) => `TRIAL_${provider.toUpperCase()}_${setting}`,
    ),
  );
  const KEY = "k".repeat(32);

  it("offers no trials, and caps them at 30 live, when nothing is set", () => {
    expect(loadConfig().trials).toEqual({ enabled: false, liveCap: 30, identityKey: "", providers: {} });
  });

  it("reads each from the environment, taking GitHub's own endpoints unless told otherwise", () => {
    vi.stubEnv("TRIALS_ENABLED", "true");
    vi.stubEnv("TRIAL_LIVE_CAP", "5");
    vi.stubEnv("TRIAL_IDENTITY_KEY", KEY);
    vi.stubEnv("TRIAL_GITHUB_CLIENT_ID", "client");
    vi.stubEnv("TRIAL_GITHUB_CLIENT_SECRET", "secret");

    expect(loadConfig().trials).toEqual({
      enabled: true,
      liveCap: 5,
      identityKey: KEY,
      providers: {
        github: {
          clientId: "client",
          clientSecret: "secret",
          authorizeUrl: "https://github.com/login/oauth/authorize",
          tokenUrl: "https://github.com/login/oauth/access_token",
          userUrl: "https://api.github.com/user",
        },
      },
    });

    vi.stubEnv("TRIAL_GITHUB_AUTHORIZE_URL", "http://localhost:4000/authorize");
    vi.stubEnv("TRIAL_GITHUB_TOKEN_URL", "http://fake-provider:4000/token");
    vi.stubEnv("TRIAL_GITHUB_USER_URL", "http://fake-provider:4000/user");
    expect(loadConfig().trials.providers.github).toEqual(
      expect.objectContaining({
        authorizeUrl: "http://localhost:4000/authorize",
        tokenUrl: "http://fake-provider:4000/token",
        userUrl: "http://fake-provider:4000/user",
      }),
    );
  });

  it("offers Google alone when only its OAuth client is configured, at Google's own endpoints", () => {
    vi.stubEnv("TRIALS_ENABLED", "true");
    vi.stubEnv("TRIAL_IDENTITY_KEY", KEY);
    vi.stubEnv("TRIAL_GOOGLE_CLIENT_ID", "client.apps.googleusercontent.com");
    vi.stubEnv("TRIAL_GOOGLE_CLIENT_SECRET", "secret");

    expect(loadConfig().trials.providers).toEqual({
      google: {
        clientId: "client.apps.googleusercontent.com",
        clientSecret: "secret",
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        userUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      },
    });

    vi.stubEnv("TRIAL_GOOGLE_USER_URL", "http://fake-provider:4000/userinfo");
    expect(loadConfig().trials.providers.google?.userUrl).toBe("http://fake-provider:4000/userinfo");
  });

  it("offers no provider whose OAuth app is not configured", () => {
    vi.stubEnv("TRIALS_ENABLED", "true");
    vi.stubEnv("TRIAL_IDENTITY_KEY", KEY);

    expect(loadConfig().trials.providers).toEqual({});
  });

  it.each([undefined, "k".repeat(31)])("refuses to start trials with an identity key of %j", (key) => {
    vi.stubEnv("TRIALS_ENABLED", "true");
    vi.stubEnv("TRIAL_IDENTITY_KEY", key);

    expect(() => loadConfig()).toThrow(/TRIAL_IDENTITY_KEY must be a secret of at least 32 characters/);
  });

  it.each([
    ["TRIAL_GITHUB_CLIENT_ID", "GITHUB"],
    ["TRIAL_GITHUB_CLIENT_SECRET", "GITHUB"],
    ["TRIAL_GOOGLE_CLIENT_ID", "GOOGLE"],
    ["TRIAL_GOOGLE_CLIENT_SECRET", "GOOGLE"],
  ])("refuses to start with only %s set", (name, provider) => {
    vi.stubEnv("TRIALS_ENABLED", "true");
    vi.stubEnv("TRIAL_IDENTITY_KEY", KEY);
    vi.stubEnv(name, "set");

    expect(() => loadConfig()).toThrow(
      new RegExp(`TRIAL_${provider}_CLIENT_ID and TRIAL_${provider}_CLIENT_SECRET must be set together`),
    );
  });

  it.each(["github.com/login", "javascript:alert(1)", "ftp://example.com/"])(
    "refuses to start with an endpoint of %j",
    (value) => {
      vi.stubEnv("TRIALS_ENABLED", "true");
      vi.stubEnv("TRIAL_IDENTITY_KEY", KEY);
      vi.stubEnv("TRIAL_GITHUB_CLIENT_ID", "client");
      vi.stubEnv("TRIAL_GITHUB_CLIENT_SECRET", "secret");
      vi.stubEnv("TRIAL_GITHUB_TOKEN_URL", value);

      expect(() => loadConfig()).toThrow(/TRIAL_GITHUB_TOKEN_URL must be an http or https URL/);
    },
  );

  // Trials let anyone create a School, so only an exact `true` turns them on.
  it.each(["1", "yes", "TRUE", "on"])("refuses to start when TRIALS_ENABLED is %j", (value) => {
    vi.stubEnv("TRIALS_ENABLED", value);

    expect(() => loadConfig()).toThrow(/TRIALS_ENABLED must be true or false/);
  });

  it.each([
    ["TRIAL_LIVE_CAP", "0"],
    ["TRIAL_LIVE_CAP", "many"],
  ])("refuses to start when %s is %j", (name, value) => {
    vi.stubEnv(name, value);

    expect(() => loadConfig()).toThrow(new RegExp(`${name} must be a positive integer`));
  });
});
