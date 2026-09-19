import { useEffect, useState, type MouseEvent } from "react";
import { api, type School } from "./api.ts";
import { navigate } from "./navigation.ts";
import { NotAvailable } from "./NotAvailable.tsx";

function personsPath(school: School): string {
  return `/schools/${encodeURIComponent(school.id)}/persons`;
}

function open(event: MouseEvent<HTMLAnchorElement>, school: School): void {
  event.preventDefault();
  navigate(personsPath(school));
}

type State =
  | { kind: "loading" }
  | { kind: "not-available" }
  | { kind: "ready"; username: string; schools: School[] };

export function Schools() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let current = true;
    void (async () => {
      const session = await api.session();
      if (!current) {
        return;
      }
      // Without a live session, whether it expired, was ended elsewhere or
      // never existed, the way on is to sign in again.
      if (!session.ok) {
        navigate("/sign-in", { replace: true });
        return;
      }
      const schools = await api.schools();
      if (!current) {
        return;
      }
      setState(
        schools.ok
          ? { kind: "ready", username: session.body.account.username, schools: schools.body.schools }
          : { kind: "not-available" },
      );
    })();
    return () => {
      current = false;
    };
  }, []);

  const signOut = async () => {
    // A sign-out that did not work leaves the session live, and the sign-in
    // page would send a live session straight back here as if nothing happened.
    if ((await api.signOut()).ok) {
      navigate("/sign-in", { replace: true });
    } else {
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
          <header className="bar">
            <span>Signed in as {state.username}</span>
            <button type="button" onClick={signOut}>
              Sign out
            </button>
          </header>
          <h1>Your Schools</h1>
          {state.schools.length === 0 ? (
            <p>Your account does not reach any School yet.</p>
          ) : (
            <ul aria-label="Schools">
              {state.schools.map((school) => (
                <li key={school.id}>
                  <a href={personsPath(school)} onClick={(event) => open(event, school)}>
                    {school.name}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </main>
      );
  }
}
