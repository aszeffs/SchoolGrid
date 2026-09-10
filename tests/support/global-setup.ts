import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { toConnectionString } from "../../src/db/connection-string.ts";
import { createPool } from "../../src/db/pool.ts";
import { migrate } from "../../src/db/migrate.ts";

export interface PostgresHandle {
  host: string;
  port: number;
  user: string;
  password: string;
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

export default async function setup({ provide }: GlobalSetup): Promise<() => Promise<void>> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "schoolgrid-pg-"));
  const port = await findFreePort();

  const postgres = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: USER,
    password: PASSWORD,
    port,
    persistent: false,
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
    templateDatabase: TEMPLATE_DATABASE,
  });

  return async () => {
    await postgres.stop();
    await rm(dataDir, { recursive: true, force: true });
  };
}
