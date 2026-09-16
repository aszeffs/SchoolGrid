import { randomUUID } from "node:crypto";
import { createUserAccount } from "../src/authentication/index.ts";
import { createPool } from "../src/db/pool.ts";
import { provisionSchool } from "../src/platform/index.ts";
import { SEEDED, type Seeded } from "./seeded.ts";

/**
 * Arranges what the browser suite signs in as, directly in the database the
 * server under test uses, as the HTTP suite's harness arranges its fixtures.
 * Accounts are provisioned, never self-registered, so there is no page to do
 * this through.
 *
 * Names carry a random suffix, so the suite can run again against a database
 * it has already run against.
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env["BROWSER_TEST_DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error("BROWSER_TEST_DATABASE_URL must name the database the server under test uses");
  }
  const database = createPool(url);
  try {
    const suffix = randomUUID().slice(0, 8);
    const credentials = { username: `alice-${suffix}`, password: `correct horse battery ${suffix}` };
    const account = await createUserAccount(database, credentials);
    const schools = [`Northside ${suffix}`, `Southside ${suffix}`];
    for (const name of schools) {
      const provisioned = await provisionSchool(database, {
        name,
        schoolAdministrator: { account, displayName: "Alice" },
        platformAdministrator: null,
      });
      if (provisioned === null) {
        throw new Error(`could not provision ${name}`);
      }
    }
    const seeded: Seeded = { schoolAdministrator: credentials, schools };
    // Workers inherit the environment the setup leaves behind.
    process.env[SEEDED] = JSON.stringify(seeded);
  } finally {
    await database.end();
  }
}
