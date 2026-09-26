import { Link } from "./Link.tsx";
import { ShellContext, useShell } from "./ShellContext.ts";
import { Sheet } from "./Sheet.tsx";

/**
 * The one state shown for anything the app cannot show: a refused request, a
 * failed one, or a page that does not exist. It says nothing about why. The API
 * tells a caller nothing about a refusal (ADR-0002), and a page that guessed at
 * a reason would tell them what the API would not. Do not add one.
 *
 * It carries no legend for the same reason: a key explaining this sheet could
 * only explain which refusal it is. Inside the shell it carries the account's
 * head and never a School's: shown under a School's name and navigation, it
 * would differ from the sheet for a School the account does not reach.
 */
export function NotAvailable() {
  const shell = useShell();
  const sheet = (
    <Sheet
      name="Not available"
      foot={
        <p>
          <Link to={{ name: "schools" }}>
            Go to your Schools
          </Link>
        </p>
      }
    >
      <h1>Not available</h1>
      <div className="panel">
        <p>This page is not available.</p>
      </div>
    </Sheet>
  );
  return shell === null ? (
    sheet
  ) : (
    <ShellContext.Provider value={{ head: shell.account, account: shell.account }}>{sheet}</ShellContext.Provider>
  );
}
