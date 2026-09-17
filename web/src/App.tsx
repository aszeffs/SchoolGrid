import { NotAvailable } from "./NotAvailable.tsx";
import { Schools } from "./Schools.tsx";
import { SignIn } from "./SignIn.tsx";
import { usePath } from "./navigation.ts";

export function App() {
  switch (usePath()) {
    case "/":
      return <Schools />;
    case "/sign-in":
      return <SignIn />;
    default:
      return <NotAvailable />;
  }
}
