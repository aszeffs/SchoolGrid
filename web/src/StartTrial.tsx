import { navigate } from "./navigation.ts";
import { landing } from "./routes.ts";
import { START_FAILED, useStartTrial } from "./trial.ts";

/**
 * A button starting a new Trial School, which opens it as its School
 * Administrator. Busy is said as busy above it, and any other failure the
 * one way.
 */
export function StartTrial({ label }: { label: string }) {
  const { start, starting, failure } = useStartTrial(({ schoolId }) =>
    navigate(landing(schoolId, ["school_administrator"]), { replace: true }),
  );
  return (
    <>
      {failure !== null && (
        <p role="alert" className="error">
          {START_FAILED[failure]}
        </p>
      )}
      <button type="button" disabled={starting} onClick={() => void start()}>
        {label}
      </button>
    </>
  );
}
