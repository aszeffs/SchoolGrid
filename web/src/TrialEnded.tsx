import { useEffect } from "react";
import { Link } from "./Link.tsx";
import { Sheet } from "./Sheet.tsx";
import { StartTrial } from "./StartTrial.tsx";
import { rememberTrial } from "./trial.ts";

/**
 * Where a Trial School's visitor lands once it has expired. It is no error
 * and no refusal: the trial ran its two hours, as it said it would, and the
 * way on is another one (ADR-0012).
 *
 * Public, like sign-in: the Session it was reached from is no longer live.
 */
export function TrialEnded() {
  // Said once. Reloaded later, or reached by its path, it still says the same.
  useEffect(() => rememberTrial(null), []);

  return (
    <Sheet
      name="Trial ended"
      foot={
        <p className="muted">
          <Link to={{ name: "howThisWasBuilt" }}>How this was built</Link>
        </p>
      }
    >
      <h1>Your trial School has been deleted</h1>
      <p>
        Its two hours are up. Every Person, record and Audit record in it was invented, and none of it remains.
      </p>
      <StartTrial label="Start a new trial" />
    </Sheet>
  );
}
