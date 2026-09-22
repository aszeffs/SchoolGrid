import { Link } from "./Link.tsx";
import { Sheet } from "./Sheet.tsx";

/**
 * The one state shown for anything the app cannot show: a refused request, a
 * failed one, or a page that does not exist. It says nothing about why. The API
 * tells a caller nothing about a refusal (ADR-0002), and a page that guessed at
 * a reason would tell them what the API would not. Do not add one.
 *
 * It carries no legend for the same reason: a key explaining this sheet could
 * only explain which refusal it is.
 */
export function NotAvailable() {
  return (
    <Sheet
      stock="buff"
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
      <p>This page is not available.</p>
    </Sheet>
  );
}
