import { writeFileSync } from "node:fs";
import { startFakeOAuthProvider } from "./fake-oauth-provider.ts";

/**
 * Runs the stand-in OAuth provider on its own, for scripts/smoke-test.sh to
 * sign the browser suite's Trial visitors in through. Run by Node directly,
 * which strips the types itself: `node tests/support/fake-oauth-provider-cli.ts`.
 *
 * Configured from the environment: FAKE_PROVIDER_CLIENT_ID and
 * FAKE_PROVIDER_CLIENT_SECRET, the app it accepts; FAKE_PROVIDER_HOST and
 * FAKE_PROVIDER_PORT, where it listens; and FAKE_PROVIDER_READY, a file it
 * writes once it is listening, for the script to wait on.
 */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const provider = await startFakeOAuthProvider({
  clientId: required("FAKE_PROVIDER_CLIENT_ID"),
  clientSecret: required("FAKE_PROVIDER_CLIENT_SECRET"),
  host: process.env["FAKE_PROVIDER_HOST"] ?? "127.0.0.1",
  port: Number(required("FAKE_PROVIDER_PORT")),
});
console.log(`fake OAuth provider listening at ${provider.url}`);
const ready = process.env["FAKE_PROVIDER_READY"];
if (ready !== undefined && ready !== "") {
  writeFileSync(ready, provider.url);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void provider.close().finally(() => process.exit(0)));
}
