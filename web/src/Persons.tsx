import { useEffect, useState, type FormEvent, type MouseEvent } from "react";
import { api, type ApiResult, type Invitation, type ListedPerson } from "./api.ts";
import { IssuedLink, PendingInvitations, type IssuedInvitation } from "./Invitations.tsx";
import { navigate } from "./navigation.ts";
import { NotAvailable } from "./NotAvailable.tsx";

type State =
  | { kind: "loading" }
  | { kind: "not-available" }
  | {
      kind: "ready";
      persons: ListedPerson[];
      /** Pending Invitations, listed only for a School Administrator; null for anyone else. */
      invitations: Invitation[] | null;
    };

type Ready = Extract<State, { kind: "ready" }>;

/** The same bound the API holds a display name to. */
const MAX_DISPLAY_NAME_LENGTH = 200;

/**
 * Whether the caller administers the School. The API includes whether a Person
 * is claimed only for a School Administrator, who is also the only caller who
 * may add a Person or manage Invitations. Anyone else would be refused, so they
 * are not offered either.
 */
function administers(persons: ListedPerson[]): boolean {
  return persons.some((person) => person.claimed !== undefined);
}

/** The page as the API now describes it, or a failure. */
async function load(schoolId: string): Promise<ApiResult<Ready>> {
  const listed = await api.persons(schoolId);
  if (!listed.ok) {
    return listed;
  }
  const { persons } = listed.body;
  if (!administers(persons)) {
    return { ok: true, body: { kind: "ready", persons, invitations: null } };
  }
  const invitations = await api.invitations(schoolId);
  return invitations.ok
    ? { ok: true, body: { kind: "ready", persons, invitations: invitations.body.invitations } }
    : invitations;
}

/** Every Person in one School that the caller may read. */
export function Persons({ schoolId }: { schoolId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedInvitation | null>(null);

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
      const loaded = await load(schoolId);
      if (!current) {
        return;
      }
      setState(loaded.ok ? loaded.body : { kind: "not-available" });
    })();
    return () => {
      current = false;
    };
  }, [schoolId]);

  /**
   * Sends a change, then shows the page as it stands afterwards, and returns
   * what was answered. A change that was refused or failed leaves the page in
   * the one state for that. A change that was made stays shown even if the
   * page cannot be listed again straight away: an Invitation's link, above
   * all, can never be asked for twice.
   */
  const sendThenReload = async <T,>(send: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> => {
    setBusy(true);
    const sent = await send();
    const loaded = sent.ok ? await load(schoolId) : null;
    setBusy(false);
    if (loaded?.ok) {
      setState(loaded.body);
    } else if (!sent.ok) {
      if (!(await api.session()).ok) {
        // A session that ended while the page was open.
        navigate("/sign-in", { replace: true });
      } else {
        setState({ kind: "not-available" });
      }
    }
    return sent;
  };

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const displayName = String(new FormData(form).get("displayName") ?? "");
    if (displayName.trim() === "") {
      return;
    }
    if ((await sendThenReload(() => api.createPerson(schoolId, { displayName }))).ok) {
      form.reset();
    }
  };

  const invite = async (person: ListedPerson) => {
    const sent = await sendThenReload(() => api.issueInvitation(schoolId, person.id));
    setIssued(sent.ok ? sent.body : null);
  };

  const revoke = async (invitation: Invitation) => {
    if ((await sendThenReload(() => api.revokeInvitation(schoolId, invitation.id))).ok) {
      // A link to a revoked Invitation is no use to anyone.
      setIssued((shown) => (shown?.invitation.id === invitation.id ? null : shown));
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
      const administering = administers(state.persons);
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
                  <span className="actions">
                    <span className="muted">{person.claimed ? "Claimed" : "Unclaimed"}</span>
                    {!person.claimed && (
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Invite ${person.displayName}`}
                        onClick={() => invite(person)}
                      >
                        Invite
                      </button>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {issued !== null && <IssuedLink issued={issued} onDone={() => setIssued(null)} />}
          {state.invitations !== null && (
            <PendingInvitations invitations={state.invitations} busy={busy} onRevoke={revoke} />
          )}
          {administering && (
            <form onSubmit={add} aria-label="Add a Person">
              <h2>Add a Person</h2>
              <label>
                Display name
                <input name="displayName" required maxLength={MAX_DISPLAY_NAME_LENGTH} autoComplete="off" />
              </label>
              <button type="submit" disabled={busy}>
                Add Person
              </button>
            </form>
          )}
        </main>
      );
    }
  }
}
