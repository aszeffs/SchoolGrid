import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { toConnectionString } from "../../src/db/connection-string.ts";
import { createPool } from "../../src/db/pool.ts";
import { migrate } from "../../src/db/migrate.ts";

export interface PostgresHandle {
  host: string;
  port: number;
  user: string;
  password: string;
  /** The login the application runs as: a member of `schoolgrid_app`, and nothing more. */
  appUser: string;
  appPassword: string;
  templateDatabase: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    postgres: PostgresHandle;
  }
}

const HOST = "localhost";
const USER = "postgres";
const PASSWORD = "postgres";
const APP_USER = "schoolgrid_runtime";
const APP_PASSWORD = "schoolgrid_runtime";
const TEMPLATE_DATABASE = "schoolgrid_template";

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Could not determine a free port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

// Typed structurally rather than against a Vitest export, so a rename in
// Vitest's node types cannot break the build for something this file only
// needs one method from.
interface GlobalSetup {
  provide(key: "postgres", value: PostgresHandle): void;
}

// embedded-postgres registers an async-exit-hook at import time so that a
// cluster is torn down if the script dies. Two of the events it hooks are
// unusable here. On `beforeExit` the hook force-exits the process with a
// hardcoded 0, discarding the exit code Vitest set for a failing run; on
// `exit` it invokes its own async shutdown with no completion callback and
// throws. Import the module with those two listeners stripped and keep the
// signal hooks, which are well behaved. Teardown below stops the cluster.
async function importEmbeddedPostgres() {
  const knownBeforeExit = new Set(process.listeners("beforeExit"));
  const knownExit = new Set(process.listeners("exit"));

  const { default: EmbeddedPostgres } = await import("embedded-postgres");

  for (const listener of process.listeners("beforeExit")) {
    if (!knownBeforeExit.has(listener)) {
      process.off("beforeExit", listener);
    }
  }
  for (const listener of process.listeners("exit")) {
    if (!knownExit.has(listener)) {
      process.off("exit", listener);
    }
  }

  return EmbeddedPostgres;
}

export default async function setup({ provide }: GlobalSetup): Promise<() => Promise<void>> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "schoolgrid-pg-"));
  const port = await findFreePort();

  const EmbeddedPostgres = await importEmbeddedPostgres();
  const postgres = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: USER,
    password: PASSWORD,
    port,
    persistent: false,
    // Left to initdb, the cluster takes the host's locale and encoding, so text
    // ordering differs between a developer's machine and CI. Pin both so a
    // result that depends on collation fails everywhere or nowhere.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
  });

  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase(TEMPLATE_DATABASE);

  // Migrate the template once. Every test database is then a copy of an
  // already-migrated database, so migrations run once per suite rather than
  // once per test.
  const templatePool = createPool(
    toConnectionString({
      host: HOST,
      port,
      user: USER,
      password: PASSWORD,
      database: TEMPLATE_DATABASE,
    }),
  );
  try {
    await migrate(templatePool);
    // Roles belong to the cluster, not to a database, so the application's
    // login is created once here and reaches every copy of the template. It is
    // arranged the way a deployment arranges it (docs/database-roles.md): a
    // plain login whose only privileges come from `schoolgrid_app`.
    await templatePool.query(
      `CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE schoolgrid_app`,
    );
  } finally {
    // The pool must be closed before any test can use this database as a
    // template: Postgres refuses to copy a database that has open sessions.
    await templatePool.end();
  }

  provide("postgres", {
    host: HOST,
    port,
    user: USER,
    password: PASSWORD,
    appUser: APP_USER,
    appPassword: APP_PASSWORD,
    templateDatabase: TEMPLATE_DATABASE,
  });

  return async () => {
    await postgres.stop();
    await rm(dataDir, { recursive: true, force: true });
  };
}
