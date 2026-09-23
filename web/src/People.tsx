import { useEffect, useState, type FormEvent } from "react";
import { MAX_NAME_LENGTH } from "../../src/validation/bounds.ts";
import { api, type ApiResult, type ListedPerson, type ReachedSchool } from "./api.ts";
import { afterFailure } from "./failed.ts";
import { IssuedLink, type IssuedInvitation } from "./IssuedLink.tsx";
import { NotAvailable } from "./NotAvailable.tsx";
import { RecordList, type Column } from "./RecordList.tsx";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";

type State = { kind: "loading" } | { kind: "not-available" } | { kind: "ready"; persons: ListedPerson[] };

/** Which sheet this page is, named once so its states cannot drift apart. */
const SHEET: SheetKind = { stock: "goldenrod", name: "People" };

/**
 * Every Person in one School that the actor may read, and — for a School
 * Administrator — whether each has been claimed yet, with the way to add one
 * and the way to invite one.
 *
 * An Invitation is issued from here, beside the Person it is for, because that
 * is the only place the choice of Person is in front of you. Where it goes
 * afterwards is the Invitations sheet's; this page does not list it.
 */
export function People({ school }: { school: ReachedSchool }) {
  const { schoolId } = school;
  /*
   * Whether to offer adding a Person and inviting one, from the roles the
   * session names (ADR-0007). Anyone else would be refused, so they are not
   * offered either; the server still decides every request. It also decides
   * whether `claimed` is sent at all, and this page shows it only where the
   * session says the actor administers the School — never by sniffing the
   * payload for the field.
   */
  const administering = school.roles.includes("school_administrator");
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedInvitation | null>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      const listed = await api.persons(schoolId);
      if (!current) {
        return;
      }
      if (listed.ok) {
        setState({ kind: "ready", persons: listed.body.persons });
      } else if ((await afterFailure()) === "not-available" && current) {
        setState({ kind: "not-available" });
      }
    })();
    return () => {
      current = false;
    };
  }, [schoolId]);

  /**
   * Sends a change, then lists the People as they stand afterwards, and returns
   * what was answered. Nothing is applied to the page before the server has
   * confirmed it: a refusal the actor cannot see is indistinguishable from a
   * success, so a change shown optimistically could be a change that never
   * happened.
   *
   * A change that was made stays made even where the listing afterwards fails.
   * An Invitation's link, above all, can never be asked for twice.
   */
  const sendThenList = async <T,>(send: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> => {
    setBusy(true);
    const sent = await send();
    const listed = sent.ok ? await api.persons(schoolId) : null;
    setBusy(false);
    if (listed?.ok) {
      setState({ kind: "ready", persons: listed.body.persons });
    } else if ((await afterFailure()) === "not-available" && !sent.ok) {
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
    if ((await sendThenList(() => api.createPerson(schoolId, { displayName }))).ok) {
      form.reset();
    }
  };

  const invite = async (person: ListedPerson) => {
    const sent = await sendThenList(() => api.issueInvitation(schoolId, person.id));
    setIssued(sent.ok ? sent.body : null);
  };

  switch (state.kind) {
    case "loading":
      return <Sheet {...SHEET} busy />;
    case "not-available":
      return <NotAvailable />;
    case "ready":
      return (
        <PeopleSheet
          persons={state.persons}
          administering={administering}
          busy={busy}
          issued={issued}
          onAdd={add}
          onInvite={invite}
          onAcknowledgeIssued={() => setIssued(null)}
        />
      );
  }
}

/** The People as they stand, narrowed to the one being looked for. */
function PeopleSheet({
  persons,
  administering,
  busy,
  issued,
  onAdd,
  onInvite,
  onAcknowledgeIssued,
}: {
  persons: ListedPerson[];
  administering: boolean;
  busy: boolean;
  issued: IssuedInvitation | null;
  onAdd: (event: FormEvent<HTMLFormElement>) => void;
  onInvite: (person: ListedPerson) => void;
  onAcknowledgeIssued: () => void;
}) {
  const [query, setQuery] = useState("");
  const looking = query.trim();
  const shown = looking === "" ? persons : persons.filter((person) => matches(person, looking));

  const legend = (
    <>
      <h2>This sheet</h2>
      <p>Every Person in this School that you may read.</p>
      <dl>
        <Key term="Person">
          An individual as known to this School. A Person need not be attached to a User account; one who never signs
          in is still a full Person.
        </Key>
        {administering && (
          <Key term="Claimed">A Person already attached to a User account. Nothing more to do here.</Key>
        )}
        {administering && (
          <Key term="Unclaimed">
            Not yet attached. Issuing an Invitation lets one human claim this Person; you hand them the link yourself,
            and the Invitation is listed on Invitations until it is used.
          </Key>
        )}
      </dl>
    </>
  );

  return (
    <Sheet {...SHEET} legend={legend}>
      <h1>People</h1>
      {persons.length > 0 && (
        <>
          <search className="filter">
            <label>
              Find by name
              <input
                type="search"
                name="find"
                value={query}
                autoComplete="off"
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
          </search>
          <p className="muted" role="status">
            {tally(shown.length, persons.length, looking)}
          </p>
        </>
      )}
      <RecordList
        label="People"
        rows={shown}
        keyOf={(person) => person.id}
        empty={emptyFor(persons.length, looking, administering)}
        columns={columnsFor(administering, busy, onInvite)}
      />
      {administering && (
        <form onSubmit={onAdd} aria-label="Add a Person">
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
      {issued !== null && <IssuedLink issued={issued} onDone={onAcknowledgeIssued} />}
    </Sheet>
  );
}

/**
 * Whether a Person is the one being looked for, by any part of their display
 * name. Matched here rather than asked of the server: the record is a School's
 * People, which is as long as a School is, and the whole of it is already on
 * the page.
 */
function matches(person: ListedPerson, looking: string): boolean {
  return person.displayName.toLocaleLowerCase().includes(looking.toLocaleLowerCase());
}

/** How much of the record is in front of you, said so a screen reader hears it change. */
function tally(shown: number, total: number, looking: string): string {
  const people = `${total} ${total === 1 ? "Person" : "People"}`;
  return looking === "" ? people : `${shown} of ${people} shown`;
}

/**
 * What the sheet says where no Person is listed. A School with none and a name
 * that matched none are different situations and read differently: the first
 * offers the first action, and the second says what was looked for.
 */
function emptyFor(total: number, looking: string, administering: boolean) {
  if (total > 0) {
    return `No Person's name contains “${looking}”.`;
  }
  return administering
    ? "No Person is recorded in this School yet. Add the first one below, then issue them an Invitation."
    : "There is no Person in this School for you to read.";
}

/**
 * The columns of the record. A Person's name is on every actor's sheet; whether
 * they have been claimed, and the offer to invite them, are on a School
 * Administrator's alone, and no other role's rendition carries either.
 */
function columnsFor(
  administering: boolean,
  busy: boolean,
  onInvite: (person: ListedPerson) => void,
): Column<ListedPerson>[] {
  const name: Column<ListedPerson> = { head: "Person", cell: (person) => person.displayName };
  if (!administering) {
    return [name];
  }
  return [
    name,
    {
      head: "State",
      cell: (person) => (
        <span className={person.claimed === true ? "mark mark--struck" : "mark mark--open"}>
          {person.claimed === true ? "Claimed" : "Unclaimed"}
        </span>
      ),
    },
    {
      head: "Invite",
      actions: true,
      cell: (person) =>
        person.claimed === true ? null : (
          <button
            type="button"
            className="button-stamp"
            disabled={busy}
            aria-label={`Invite ${person.displayName}`}
            onClick={() => onInvite(person)}
          >
            Invite
          </button>
        ),
    },
  ];
}
