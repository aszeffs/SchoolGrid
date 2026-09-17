import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { navigate } from "./navigation.ts";
import { NotAvailable } from "./NotAvailable.tsx";

// The same bound sign-in holds a password to.
const MAX_PASSWORD_LENGTH = 1024;

type State =
  | { kind: "loading" }
  | { kind: "not-available" }
  | { kind: "ready"; schoolName: string; personDisplayName: string; usernameTaken: boolean };

/**
 * The secret a redemption link carries. It lives in the fragment, which a
 * browser never sends to any server, so page script is the only thing that
 * ever reads it, and it never appears in a request URL or a server log.
 */
function secretFromHash(): string {
  return location.hash.slice(1);
}

/** Redeeming an Invitation with a brand new User account. */
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
              usernameTaken: false,
            }
          : { kind: "not-available" },
      );
    });
    return () => {
      current = false;
    };
  }, [secret]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state.kind !== "ready") {
      return;
    }
    const form = new FormData(event.currentTarget);
    const username = String(form.get("username") ?? "");
    const password = String(form.get("password") ?? "");
    setSubmitting(true);
    const result = await api.redeemInvitation({ secret, username, password });
    setSubmitting(false);
    switch (result.status) {
      case "redeemed":
        navigate("/", { replace: true });
        return;
      case "username_unavailable":
        setState({ ...state, usernameTaken: true });
        return;
      case "refused":
        // Whatever the cause, this is the same stale state as an unknown,
        // expired, revoked, or already-redeemed link (ADR-0002): the page
        // does not say which, and it should be commented where it is decided,
        // not guessed at again here. See invitation-redemption-routes.ts.
        setState({ kind: "not-available" });
    }
  };

  switch (state.kind) {
    case "loading":
      return <main className="panel" aria-busy="true" />;
    case "not-available":
      return <NotAvailable />;
    case "ready":
      return (
        <main className="panel">
          <h1>Join {state.schoolName}</h1>
          <p>
            This Invitation is for <strong>{state.personDisplayName}</strong>.
          </p>
          <form onSubmit={submit}>
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
        </main>
      );
  }
}
