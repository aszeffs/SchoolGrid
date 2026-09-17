import { useEffect, useState, type FormEvent, type MouseEvent } from "react";
import { api, type ListedPerson } from "./api.ts";
import { navigate } from "./navigation.ts";
import { NotAvailable } from "./NotAvailable.tsx";

type State =
  | { kind: "loading" }
  | { kind: "not-available" }
  | { kind: "ready"; persons: ListedPerson[] };

/** The same bound the API holds a display name to. */
const MAX_DISPLAY_NAME_LENGTH = 200;

/** Every Person in one School that the caller may read. */
export function Persons({ schoolId }: { schoolId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [adding, setAdding] = useState(false);

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
      const listed = await api.persons(schoolId);
      if (!current) {
        return;
      }
      setState(listed.ok ? { kind: "ready", persons: listed.body.persons } : { kind: "not-available" });
    })();
    return () => {
      current = false;
    };
  }, [schoolId]);

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const displayName = String(new FormData(form).get("displayName") ?? "");
    if (displayName.trim() === "") {
      return;
    }
    setAdding(true);
    const created = await api.createPerson(schoolId, { displayName });
    const listed = created.ok ? await api.persons(schoolId) : created;
    setAdding(false);
    if (listed.ok) {
      form.reset();
      setState({ kind: "ready", persons: listed.body.persons });
    } else if (!(await api.session()).ok) {
      // A session that ended while the page was open.
      navigate("/sign-in", { replace: true });
    } else {
      setState({ kind: "not-available" });
    }
  };

  const home = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    navigate("/");
  };

  switch (state.kind) {
    case "loading":
      return <main className="panel" aria-busy="true" />;
    case "not-available":
      return <NotAvailable />;
    case "ready": {
      // The API includes whether a Person is claimed only for a School
      // Administrator, who is also the only caller who may add a Person. Anyone
      // else would be refused, so they are not offered the form.
      const administering = state.persons.some((person) => person.claimed !== undefined);
      return (
        <main className="panel">
          <p>
            <a href="/" onClick={home}>
              Your Schools
            </a>
          </p>
          <h1>Persons</h1>
          <ul aria-label="Persons" className="persons">
            {state.persons.map((person) => (
              <li key={person.id}>
                <span>{person.displayName}</span>
                {person.claimed !== undefined && (
                  <span className="muted">{person.claimed ? "Claimed" : "Unclaimed"}</span>
                )}
              </li>
            ))}
          </ul>
          {administering && (
            <form onSubmit={add} aria-label="Add a Person">
              <h2>Add a Person</h2>
              <label>
                Display name
                <input name="displayName" required maxLength={MAX_DISPLAY_NAME_LENGTH} autoComplete="off" />
              </label>
              <button type="submit" disabled={adding}>
                Add Person
              </button>
            </form>
          )}
        </main>
      );
    }
  }
}
