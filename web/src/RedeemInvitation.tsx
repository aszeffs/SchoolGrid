import { useEffect, useState, type FormEvent } from "react";
import { MAX_PASSWORD_LENGTH } from "../../src/validation/bounds.ts";
import { api } from "./api.ts";
import { navigate } from "./navigation.ts";
import { NotAvailable } from "./NotAvailable.tsx";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";

/** Which sheet this page is, named once so the two states cannot drift apart. */
const SHEET: SheetKind = { stock: "pink", name: "Invitation" };

/** Whether the invited person is creating an account or signing in to one they have. */
type AccountChoice = "new" | "existing";

type State =
  | { kind: "loading" }
  | { kind: "not-available" }
  | {
      kind: "ready";
      schoolName: string;
      personDisplayName: string;
      account: AccountChoice;
      usernameTaken: boolean;
      signInFailed: boolean;
    };

/**
 * The secret a redemption link carries. It lives in the fragment, which a
 * browser never sends to any server, so page script is the only thing that
 * ever reads it, and it never appears in a request URL or a server log.
 */
function secretFromHash(): string {
  return location.hash.slice(1);
}

function credentialsOf(event: FormEvent<HTMLFormElement>) {
  const form = new FormData(event.currentTarget);
  return { username: String(form.get("username") ?? ""), password: String(form.get("password") ?? "") };
}

/** Redeeming an Invitation, with a brand new User account or one the person already has. */
export function RedeemInvitation() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [submitting, setSubmitting] = useState(false);
  const secret = secretFromHash();

  useEffect(() => {
    let current = true;
    if (secret === "") {
      setState({ kind: "not-available" });
      return;
    }
    void api.inspectInvitation(secret).then((inspected) => {
      if (!current) {
        return;
      }
      setState(
        inspected.ok
          ? {
              kind: "ready",
              schoolName: inspected.body.school.name,
              personDisplayName: inspected.body.person.displayName,
              account: "new",
              usernameTaken: false,
              signInFailed: false,
            }
          : { kind: "not-available" },
      );
    });
    return () => {
      current = false;
    };
  }, [secret]);

  // Whatever the cause, a refused redemption is the same stale state as an
  // unknown, expired, revoked, or already-redeemed link (ADR-0002): the page
  // does not say which, and it should be commented where it is decided, not
  // guessed at again here. See invitation-redemption-routes.ts.
  const refused = () => setState({ kind: "not-available" });

  const redeemWithNewAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state.kind !== "ready") {
      return;
    }
    setSubmitting(true);
    const result = await api.redeemInvitation({ secret, ...credentialsOf(event) });
    setSubmitting(false);
    switch (result.status) {
      case "redeemed":
        navigate({ name: "schools" }, { replace: true });
        return;
      case "username_unavailable":
        setState({ ...state, usernameTaken: true });
        return;
      case "refused":
        refused();
    }
  };

  const redeemWithExistingAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state.kind !== "ready") {
      return;
    }
    setSubmitting(true);
    const signedIn = await api.signIn(credentialsOf(event));
    if (!signedIn.ok) {
      setSubmitting(false);
      setState({ ...state, signInFailed: true });
      return;
    }
    const redeemed = await api.redeemInvitationSignedIn(secret);
    setSubmitting(false);
    if (redeemed.ok) {
      navigate({ name: "schools" }, { replace: true });
    } else {
      refused();
    }
  };

  const choose = (account: AccountChoice) => {
    if (state.kind === "ready") {
      setState({ ...state, account, usernameTaken: false, signInFailed: false });
    }
  };

  switch (state.kind) {
    case "loading":
      return <Sheet {...SHEET} busy />;
    case "not-available":
      return <NotAvailable />;
    case "ready":
      return (
        <Sheet
          {...SHEET}
          legend={
            <>
              <h2>This sheet</h2>
              <p>Claiming the Person this Invitation names.</p>
              <dl>
                <Key term="Once">
                  An Invitation is redeemable once and expires. A School Administrator may revoke it before then.
                </Key>
                <Key term="No role">
                  Redeeming attaches you to this Person. It grants no role: memberships, Enrollments and Guardian
                  links are granted separately.
                </Key>
              </dl>
            </>
          }
        >
          <h1>Join {state.schoolName}</h1>
          <p>
            This Invitation is for <strong>{state.personDisplayName}</strong>.
          </p>
          {state.account === "new" ? (
            <>
              <form key="new" onSubmit={redeemWithNewAccount}>
                <label>
                  Username
                  <input name="username" autoComplete="username" required />
                </label>
                <label>
                  Password
                  <input
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    required
                    maxLength={MAX_PASSWORD_LENGTH}
                  />
                </label>
                {state.usernameTaken && (
                  <p role="alert" className="error">
                    That username is already taken. Choose another.
                  </p>
                )}
                <button type="submit" disabled={submitting}>
                  Redeem Invitation
                </button>
              </form>
              <button type="button" className="button-ghost" onClick={() => choose("existing")} disabled={submitting}>
                I already have an account
              </button>
            </>
          ) : (
            <>
              <form key="existing" onSubmit={redeemWithExistingAccount}>
                <label>
                  Username
                  <input name="username" autoComplete="username" required />
                </label>
                <label>
                  Password
                  <input name="password" type="password" autoComplete="current-password" required />
                </label>
                {/* The same one message sign-in shows, whatever went wrong: see SignIn.tsx. */}
                {state.signInFailed && (
                  <p role="alert" className="error">
                    Sign-in did not work. Check your details and try again.
                  </p>
                )}
                <button type="submit" disabled={submitting}>
                  Sign in and redeem
                </button>
              </form>
              <button type="button" className="button-ghost" onClick={() => choose("new")} disabled={submitting}>
                Create a new account instead
              </button>
            </>
          )}
        </Sheet>
      );
  }
}
