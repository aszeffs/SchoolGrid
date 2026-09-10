import { loadConfig } from "./config.ts";
import { createPool } from "./db/pool.ts";
import { migrate } from "./db/migrate.ts";
import { buildServer } from "./server.ts";

const config = loadConfig();
const database = createPool(config.databaseUrl);
const app = buildServer({ database, logLevel: config.logLevel });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await database.end();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  // Booting against an unmigrated database would otherwise succeed silently
  // and fail later, at whichever request first touched a missing table.
  const result = await migrate(database);
  if (result.applied.length > 0) {
    app.log.info({ applied: result.applied }, "applied migrations");
  }

  await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (error) {
  app.log.fatal({ err: error }, "failed to start");
  await database.end();
  process.exit(1);
}
