import { NotAvailable } from "./NotAvailable.tsx";
import { Persons } from "./Persons.tsx";
import { RedeemInvitation } from "./RedeemInvitation.tsx";
import { Schools } from "./Schools.tsx";
import { SignIn } from "./SignIn.tsx";
import { usePath } from "./navigation.ts";

const PERSONS = /^\/schools\/([^/]+)\/persons$/;

/** A path segment as written, decoded; null when absent or not validly encoded. */
function segment(encoded: string | undefined): string | null {
  if (encoded === undefined) {
    return null;
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

export function App() {
  const path = usePath();
  const schoolId = segment(PERSONS.exec(path)?.[1]);
  if (schoolId !== null) {
    // Whatever the path names, the API decides whether it is available.
    return <Persons key={schoolId} schoolId={schoolId} />;
  }
  switch (path) {
    case "/":
      return <Schools />;
    case "/sign-in":
      return <SignIn />;
    case "/invitation":
      return <RedeemInvitation />;
    default:
      return <NotAvailable />;
  }
}
