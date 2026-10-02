import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parsePublicOrigin, TRIAL_PROVIDERS, type TrialSettings } from "../../src/config.ts";
import { toConnectionString } from "../../src/db/connection-string.ts";
import { createPool } from "../../src/db/pool.ts";
import { loadWebApp } from "../../src/http/web-app.ts";
import { buildServer } from "../../src/server.ts";
import { startFakeOAuthProvider, USER_ENDPOINTS } from "../../tests/support/fake-oauth-provider.ts";
import { startEmbeddedPostgres } from "../../tests/support/embedded-postgres.ts";

/**
 * SchoolGrid as the public showcase runs it, on this machine and in this
 * process, with no Docker: an embedded Postgres, migrated, the service serving
 * the built web app with trials on, and the stand-in OAuth provider to sign a
 * Trial visitor in through, configured as both GitHub and Google.
 *
 * The same pieces the HTTP suite boots, put together the way
 * scripts/smoke-test.sh puts the image together, for what needs a real
 * browser in a real trial on a developer's machine: the tour's screenshots.
 */
export interface Showcase {
  close(): Promise<void>;
}

const CLIENT_ID = "schoolgrid-showcase";
const CLIENT_SECRET = "showcase-client-secret";
/** Not a secret: it hashes only the stand-in provider's invented subjects. */
const IDENTITY_KEY = "local-showcase-identity-key-not-a-secret";

const WEB_APP = new URL("../../web/dist/", import.meta.url);

export async function startShowcase({ port }: { port: number }): Promise<Showcase> {
  try {
    await access(fileURLToPath(new URL("index.html", WEB_APP)));
  } catch {
    throw new Error("web/dist is missing: run `npm run build` first, so the showcase serves the app as it ships");
  }

  // The HTTP suite's own cluster: migrated, with the application's login
  // arranged as a deployment arranges it. It names its one database a
  // template, as the suite copies it; here it is simply the database.
  const { handle, stop: stopPostgres } = await startEmbeddedPostgres();
  const { host, port: databasePort, appUser, appPassword, templateDatabase } = handle;
  const databaseUrl = toConnectionString({
    host,
    port: databasePort,
    user: appUser,
    password: appPassword,
    database: templateDatabase,
  });

  const provider = await startFakeOAuthProvider({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const providers: TrialSettings["providers"] = {};
  for (const name of TRIAL_PROVIDERS) {
    providers[name] = {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      authorizeUrl: `${provider.url}/authorize`,
      tokenUrl: `${provider.url}/token`,
      userUrl: `${provider.url}${USER_ENDPOINTS[name].path}`,
    };
  }

  const origin = `http://localhost:${port}`;
  const database = createPool(databaseUrl);
  const app = buildServer({
    database,
    logLevel: "warn",
    // One browser, from one address, opening many pages: nothing here is worth throttling.
    rateLimit: { max: 100_000, windowMs: 60_000 },
    publicOrigin: parsePublicOrigin(origin),
    trials: { enabled: true, liveCap: 30, identityKey: IDENTITY_KEY, providers },
    webApp: await loadWebApp(WEB_APP),
  });
  await app.listen({ port, host: "localhost" });

  return {
    async close() {
      await app.close();
      await database.end();
      await provider.close();
      await stopPostgres();
    },
  };
}
