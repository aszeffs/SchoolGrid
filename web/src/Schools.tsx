import { useEffect, useState, type MouseEvent } from "react";
import { api, type School } from "./api.ts";
import { navigate } from "./navigation.ts";
import { NotAvailable } from "./NotAvailable.tsx";
import { Key, LoadingSheet, Sheet } from "./Sheet.tsx";

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
      return <LoadingSheet stock="blue" name="Schools" />;
    case "not-available":
      return <NotAvailable />;
    case "ready": {
      const legend = (
        <>
          <h2>This sheet</h2>
          <p>The Schools your account reaches.</p>
          <dl>
            <Key term="School">
              The boundary every record belongs to. No record is shared between Schools, and the same human at two
              Schools is two unrelated Persons.
            </Key>
            <Key term="Reach">
              Your account resolves to at most one Person per School. A School you cannot reach is not listed.
            </Key>
          </dl>
        </>
      );
      const head = (
        <div className="actions">
          <span className="sheet__no">Signed in as {state.username}</span>
          <button type="button" className="button-quiet" onClick={signOut}>
            Sign out
          </button>
        </div>
      );
      return (
        <Sheet stock="blue" name="Schools" legend={legend} head={head}>
          <h1>Your Schools</h1>
          {state.schools.length === 0 ? (
            <p className="empty">Your account does not reach any School yet.</p>
          ) : (
            <ul aria-label="Schools" className="roster">
              {state.schools.map((school) => (
                <li key={school.id}>
                  <span className="roster__name">
                    <a href={personsPath(school)} onClick={(event) => open(event, school)}>
                      {school.name}
                    </a>
                  </span>
                  {/* The leader carries no text: a listed School reads as its name and nothing else. */}
                  <span className="roster__leader" />
                </li>
              ))}
            </ul>
          )}
        </Sheet>
      );
    }
  }
}
