import { HowThisWasBuilt } from "./HowThisWasBuilt.tsx";
import { RedeemInvitation } from "./RedeemInvitation.tsx";
import { SignedIn } from "./Shell.tsx";
import { SignIn } from "./SignIn.tsx";
import { TrialEnded } from "./TrialEnded.tsx";
import { useRoute } from "./navigation.ts";

export function App() {
  const route = useRoute();
  switch (route?.name) {
    case "signIn":
      return <SignIn />;
    case "invitation":
      return <RedeemInvitation />;
    case "howThisWasBuilt":
      return <HowThisWasBuilt />;
    case "trialEnded":
      return <TrialEnded />;
    default:
      // Whatever School the path names, the session decides whether it is
      // reached. A path that names nothing is shown to a signed-in user the
      // same way as a School they do not reach.
      return <SignedIn route={route} />;
  }
}
