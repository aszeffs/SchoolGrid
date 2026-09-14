import { loadConfig } from "./config.ts";
import { createPool } from "./db/pool.ts";
import { migrate } from "./db/migrate.ts";
import { assertLeastPrivilege } from "./db/runtime-role.ts";
import { buildServer } from "./server.ts";

const config = loadConfig();
const database = createPool(config.databaseUrl);
const app = buildServer({
  database,
  logLevel: config.logLevel,
  rateLimit: config.rateLimit,
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await database.end();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

/**
 * Migrates as the schema owner, over a connection that is closed before the
 * application serves anything. The owner's credentials never back a request.
 */
async function migrateAsOwner(): Promise<void> {
  const owner = createPool(config.migrationDatabaseUrl);
  try {
    const result = await migrate(owner);
    if (result.applied.length > 0) {
      app.log.info({ applied: result.applied }, "applied migrations");
    }
  } finally {
    await owner.end();
  }
}

try {
  // Booting against an unmigrated database would otherwise succeed silently
  // and fail later, at whichever request first touched a missing table.
  await migrateAsOwner();
  await assertLeastPrivilege(database);

  await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (error) {
  app.log.fatal({ err: error }, "failed to start");
  await database.end();
  process.exit(1);
}
