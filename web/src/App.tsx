import { HowThisWasBuilt } from "./HowThisWasBuilt.tsx";
import { NotAvailable } from "./NotAvailable.tsx";
import { RedeemInvitation } from "./RedeemInvitation.tsx";
import { SignedIn } from "./Shell.tsx";
import { SignIn } from "./SignIn.tsx";
import { useRoute } from "./navigation.ts";

export function App() {
  const route = useRoute();
  if (route === null) {
    return <NotAvailable />;
  }
  switch (route.name) {
    case "signIn":
      return <SignIn />;
    case "invitation":
      return <RedeemInvitation />;
    case "howThisWasBuilt":
      return <HowThisWasBuilt />;
    default:
      // Whatever School the path names, the session decides whether it is reached.
      return <SignedIn route={route} />;
  }
}
