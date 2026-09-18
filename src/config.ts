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
}

export const DEFAULT_RATE_LIMIT: RateLimit = { max: 100, windowMs: 60_000 };

export interface Config extends MigrationConfig {
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
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
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
    ...loadMigrationConfig(),
    port,
    logLevel,
    rateLimit: {
      max: positiveIntegerEnv("RATE_LIMIT_MAX", DEFAULT_RATE_LIMIT.max),
      windowMs: positiveIntegerEnv("RATE_LIMIT_WINDOW_MS", DEFAULT_RATE_LIMIT.windowMs),
    },
    publicOrigin: parsePublicOrigin(requireEnv("PUBLIC_ORIGIN")),
  };
}
