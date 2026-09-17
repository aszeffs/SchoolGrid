import type { MouseEvent } from "react";
import { navigate } from "./navigation.ts";

/**
 * The one state shown for anything the app cannot show: a refused request, a
 * failed one, or a page that does not exist. It says nothing about why. The API
 * tells a caller nothing about a refusal (ADR-0002), and a page that guessed at
 * a reason would tell them what the API would not. Do not add one.
 */
export function NotAvailable() {
  const home = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    navigate("/");
  };
  return (
    <main className="panel">
      <h1>Not available</h1>
      <p>This page is not available.</p>
      <p>
        <a href="/" onClick={home}>
          Go to your Schools
        </a>
      </p>
    </main>
  );
}
