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

export interface Config {
  databaseUrl: string;
  port: number;
  logLevel: LogLevel;
  rateLimit: RateLimit;
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

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
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
    port,
    logLevel,
    rateLimit: {
      max: positiveIntegerEnv("RATE_LIMIT_MAX", DEFAULT_RATE_LIMIT.max),
      windowMs: positiveIntegerEnv("RATE_LIMIT_WINDOW_MS", DEFAULT_RATE_LIMIT.windowMs),
    },
  };
}
