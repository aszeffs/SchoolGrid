import { loadConfig } from "../config.ts";
import { createPool } from "./pool.ts";
import { migrate } from "./migrate.ts";

const config = loadConfig();
const pool = createPool(config.databaseUrl);

try {
  const result = await migrate(pool);
  if (result.applied.length === 0) {
    console.log(`No migrations to apply (${result.alreadyApplied.length} already applied).`);
  } else {
    console.log(`Applied ${result.applied.length} migration(s):`);
    for (const name of result.applied) console.log(`  ${name}`);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
