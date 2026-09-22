import { useEffect, useState, type FormEvent } from "react";
import { MAX_NAME_LENGTH } from "../../src/validation/bounds.ts";
import { api, type ApiResult, type Invitation, type ListedPerson, type ReachedSchool } from "./api.ts";
import { IssuedLink, PendingInvitations, type IssuedInvitation } from "./Invitations.tsx";
import { navigate } from "./navigation.ts";
import { NotAvailable } from "./NotAvailable.tsx";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";

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

/** Which sheet this page is, named once so the two states cannot drift apart. */
const SHEET: SheetKind = { stock: "goldenrod", name: "Persons" };

/** The page as the API now describes it, or a failure. */
async function load(schoolId: string, administering: boolean): Promise<ApiResult<Ready>> {
  const listed = await api.persons(schoolId);
  if (!listed.ok) {
    return listed;
  }
  const { persons } = listed.body;
  if (!administering) {
    return { ok: true, body: { kind: "ready", persons, invitations: null } };
  }
  const invitations = await api.invitations(schoolId);
  return invitations.ok
    ? { ok: true, body: { kind: "ready", persons, invitations: invitations.body.invitations } }
    : invitations;
}

/** Every Person in one School that the caller may read. */
export function Persons({ school }: { school: ReachedSchool }) {
  const { schoolId } = school;
  /*
   * Whether to offer adding a Person and managing Invitations, from the roles
   * the session names (ADR-0007). Anyone else would be refused, so they are
   * not offered either; the server still decides every request.
   */
  const administering = school.roles.includes("school_administrator");
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedInvitation | null>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      const loaded = await load(schoolId, administering);
      if (!current) {
        return;
      }
      if (loaded.ok) {
        setState(loaded.body);
        return;
      }
      const session = await api.session();
      if (!current) {
        return;
      }
      if (session.ok) {
        setState({ kind: "not-available" });
      } else {
        // The session ended after the shell read it.
        navigate({ name: "signIn" }, { replace: true });
      }
    })();
    return () => {
      current = false;
    };
  }, [schoolId, administering]);

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
    const loaded = sent.ok ? await load(schoolId, administering) : null;
    setBusy(false);
    if (loaded?.ok) {
      setState(loaded.body);
    } else if (!(await api.session()).ok) {
      // A session that ended while the page was open, whether the change itself
      // was refused or the reload after a change that succeeded was.
      navigate({ name: "signIn" }, { replace: true });
    } else if (!sent.ok) {
      setState({ kind: "not-available" });
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

  switch (state.kind) {
    case "loading":
      return <Sheet {...SHEET} busy />;
    case "not-available":
      return <NotAvailable />;
    case "ready": {
      const legend = (
        <>
          <h2>This sheet</h2>
          <p>Every Person in this School that you may read.</p>
          <dl>
            <Key term="Person">
              An individual as known to this School. A Person need not be attached to a User account; one who never
              signs in is still a full Person.
            </Key>
            {administering && (
              <Key term="Claimed">A Person already attached to a User account. Nothing more to do here.</Key>
            )}
            {administering && (
              <Key term="Unclaimed">
                Not yet attached. Issuing an Invitation lets one human claim this Person; you hand them the link
                yourself.
              </Key>
            )}
          </dl>
        </>
      );
      return (
        <Sheet {...SHEET} legend={legend}>
          <h1>Persons</h1>
          <ul aria-label="Persons" className="roster">
            {state.persons.map((person) => (
              <li key={person.id}>
                <span className="roster__name">{person.displayName}</span>
                {administering && (
                  <>
                    <span className="roster__leader" />
                    <span className="roster__state">
                      <span className={person.claimed ? "mark mark--struck" : "mark mark--open"}>
                        {person.claimed ? "Claimed" : "Unclaimed"}
                      </span>
                      {!person.claimed && (
                        <button
                          type="button"
                          className="button-quiet"
                          disabled={busy}
                          aria-label={`Invite ${person.displayName}`}
                          onClick={() => invite(person)}
                        >
                          Invite
                        </button>
                      )}
                    </span>
                  </>
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
                <input name="displayName" required maxLength={MAX_NAME_LENGTH} autoComplete="off" />
              </label>
              <button type="submit" disabled={busy}>
                Add Person
              </button>
            </form>
          )}
        </Sheet>
      );
    }
  }
}
