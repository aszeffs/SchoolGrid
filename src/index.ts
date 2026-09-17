import { loadConfig } from "./config.ts";
import { createPool } from "./db/pool.ts";
import { migrate } from "./db/migrate.ts";
import { assertLeastPrivilege } from "./db/runtime-role.ts";
import { loadWebApp, type WebApp } from "./http/web-app.ts";
import { buildServer } from "./server.ts";

const config = loadConfig();
const database = createPool(config.databaseUrl);
const webApp = await loadBuiltWebApp();
const app = buildServer({
  database,
  logLevel: config.logLevel,
  rateLimit: config.rateLimit,
  publicOrigin: config.publicOrigin,
  ...(webApp === null ? {} : { webApp }),
});
if (webApp === null) {
  app.log.warn("the web app has not been built, so only the API is served");
}

/**
 * The web app's build, where the image puts it: beside the compiled service,
 * as `web/dist` is beside `src` in a checkout. Absent only in a checkout that
 * has not built it, where the API alone is still worth running.
 */
async function loadBuiltWebApp(): Promise<WebApp | null> {
  try {
    return await loadWebApp(new URL("../web/dist/", import.meta.url));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

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
