import { useState } from "react";
import type { TrialProvider } from "../../src/config.ts";
import { PROVIDER_NAMES, START_FAILED, startPath, takeStartFailure } from "./trial.ts";

/**
 * Starting a Trial School: a button for each provider the visitor can sign in
 * with, each leaving for that provider and coming back into the new School as
 * its School Administrator (ADR-0013). A sign-in that started nothing comes
 * back here, and says why above the buttons.
 *
 * Each is a form sent by the browser itself, not a fetch: the visitor goes to
 * the provider's own page. It carries the browser's timezone, so the School's
 * dates look right to them; the server falls back to UTC for one it does not know.
 */
export function StartTrial({ providers }: { providers: readonly TrialProvider[] }) {
  const [failure] = useState(takeStartFailure);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <>
      {failure !== null && (
        <p role="alert" className="error">
          {START_FAILED[failure]}
        </p>
      )}
      <div className="start-trial">
        {providers.map((provider) => (
          <form key={provider} method="get" action={startPath(provider)}>
            <input type="hidden" name="timezone" value={timezone} />
            <button type="submit">Continue with {PROVIDER_NAMES[provider]}</button>
          </form>
        ))}
      </div>
    </>
  );
}
