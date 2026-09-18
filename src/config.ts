export const LOG_LEVELS = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** How many requests one client address may make within one window. */
export interface RateLimit {
  max: number;
  windowMs: number;
  /**
   * The request header holding the client's address, lower case as Node names
   * it, for a request without it falling back to the socket's. Trusted as is:
   * set it only behind a proxy that overwrites the header, or any caller could
   * choose their own key. Unset, every request is keyed on the socket address.
   */
  clientAddressHeader?: string;
}

export const DEFAULT_RATE_LIMIT: RateLimit = { max: 100, windowMs: 60_000 };

export interface Config extends Partial<MigrationConfig> {
  /** The application's own least-privilege role. See docs/database-roles.md. */
  databaseUrl: string;
  port: number;
  logLevel: LogLevel;
  rateLimit: RateLimit;
  /**
   * The origin browsers reach SchoolGrid at, as a browser writes it in an
   * `Origin` header: a change made with a cookie session must come from here.
   */
  publicOrigin: PublicOrigin;
  buildInfo: BuildInfo;
}

/**
 * What the running service was built from, as far as it knows. Either may be
 * absent, as both are in local development. Neither is School-scoped: both are
 * public, and served to anyone who asks.
 */
export interface BuildInfo {
  /** The full SHA of the commit the image was built from, baked in at build. */
  commit?: string;
  /**
   * The digest of the image this service runs from. It cannot live inside the
   * image it identifies, so the deploy supplies it at runtime.
   */
  digest?: string;
}

/** A variable's value, treating one set to nothing as not set at all. */
function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === "" ? undefined : value;
}

function requireEnv(name: string): string {
  const value = optionalEnv(name);
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, received: ${raw}`);
  }
  return value;
}

// Browsers keep a `Secure` cookie over plain http only on these hosts.
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/**
 * An origin and nothing more, normalised as a browser serialises it, which
 * `parsePublicOrigin` alone makes. Anything else could never equal the
 * `Origin` a browser sends, so every change made with a cookie would be refused.
 */
export type PublicOrigin = string & { readonly __brand: "PublicOrigin" };

/** Parses the origin browsers reach SchoolGrid at, or throws if it is not one a browser could send. */
export function parsePublicOrigin(raw: string): PublicOrigin {
  const invalid = () =>
    new Error(`PUBLIC_ORIGIN must be an https origin, or http on localhost, with no path, received: ${raw}`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid();
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname));
  const onlyAnOrigin =
    url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === "";
  if (!secure || !onlyAnOrigin) {
    throw invalid();
  }
  return url.origin as PublicOrigin;
}

// A header name is an RFC 9110 token.
const HEADER_NAME_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** The header the client's address is read from, if one is named. */
function optionalClientAddressHeader(): Pick<RateLimit, "clientAddressHeader"> {
  const raw = optionalEnv("CLIENT_ADDRESS_HEADER");
  if (raw === undefined) {
    return {};
  }
  if (!HEADER_NAME_TOKEN.test(raw)) {
    throw new Error(`CLIENT_ADDRESS_HEADER must be an HTTP header name, received: ${JSON.stringify(raw)}`);
  }
  return { clientAddressHeader: raw.toLowerCase() };
}

// A full SHA-1 or SHA-256 commit name, as git writes it.
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * The build info the environment gives. Each value is rendered into a link and
 * a command a visitor runs, so one in any other form fails startup rather than
 * showing them something that cannot be checked.
 */
function loadBuildInfo(): BuildInfo {
  const commit = optionalEnv("BUILD_COMMIT");
  if (commit !== undefined && !COMMIT_SHA.test(commit)) {
    throw new Error(`BUILD_COMMIT must be a full commit SHA in lower case, received: ${JSON.stringify(commit)}`);
  }
  const digest = optionalEnv("IMAGE_DIGEST");
  if (digest !== undefined && !IMAGE_DIGEST.test(digest)) {
    throw new Error(`IMAGE_DIGEST must be a sha256 image digest, received: ${JSON.stringify(digest)}`);
  }
  return {
    ...(commit === undefined ? {} : { commit }),
    ...(digest === undefined ? {} : { digest }),
  };
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export interface MigrationConfig {
  /** The schema owner, used only to migrate and never to serve requests. */
  migrationDatabaseUrl: string;
}

export function loadMigrationConfig(): MigrationConfig {
  return { migrationDatabaseUrl: requireEnv("MIGRATION_DATABASE_URL") };
}

/**
 * The migration connection when one is given. Without it the service does not
 * migrate on startup, and only checks that someone else already has: that is
 * how production runs, holding the application's role alone.
 */
function optionalMigrationConfig(): Partial<MigrationConfig> {
  const migrationDatabaseUrl = optionalEnv("MIGRATION_DATABASE_URL");
  return migrationDatabaseUrl === undefined ? {} : { migrationDatabaseUrl };
}

export function loadConfig(): Config {
  const port = Number(process.env["PORT"] ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a valid port number, received: ${process.env["PORT"]}`);
  }

  const logLevel = process.env["LOG_LEVEL"] ?? "info";
  if (!isLogLevel(logLevel)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, received: ${logLevel}`);
  }

  return {
    databaseUrl: requireEnv("DATABASE_URL"),
    ...optionalMigrationConfig(),
    port,
    logLevel,
    rateLimit: {
      max: positiveIntegerEnv("RATE_LIMIT_MAX", DEFAULT_RATE_LIMIT.max),
      windowMs: positiveIntegerEnv("RATE_LIMIT_WINDOW_MS", DEFAULT_RATE_LIMIT.windowMs),
      ...optionalClientAddressHeader(),
    },
    publicOrigin: parsePublicOrigin(requireEnv("PUBLIC_ORIGIN")),
    buildInfo: loadBuildInfo(),
  };
}
