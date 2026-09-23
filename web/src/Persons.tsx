import { useState, type FormEvent, type ReactNode } from "react";
import { MAX_NAME_LENGTH } from "../../src/validation/bounds.ts";
import { api, type ListedPerson, type ReachedSchool } from "./api.ts";
import { IssuedLink, type IssuedInvitation } from "./IssuedLink.tsx";
import { NotAvailable } from "./NotAvailable.tsx";
import { RecordList, type Column } from "./RecordList.tsx";
import { useScreen } from "./screen.ts";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";

/** Which sheet this page is, named once so its states cannot drift apart. */
const SHEET: SheetKind = { stock: "goldenrod", name: "Persons" };

/**
 * Every Person in one School that the actor may read, and — for a School
 * Administrator — whether each has been claimed yet, with the way to add one
 * and the way to invite one.
 *
 * An Invitation is issued from here, beside the Person it is for, because this
 * is the only sheet where the choice of Person is in front of you. Where it
 * goes afterwards is the Invitations sheet's; this page does not list it.
 */
export function Persons({ school }: { school: ReachedSchool }) {
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
  const { showing, busy, change } = useScreen(schoolId, api.persons);
  const [issued, setIssued] = useState<IssuedInvitation | null>(null);

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const displayName = String(new FormData(form).get("displayName") ?? "");
    if (displayName.trim() === "") {
      return;
    }
    if ((await change(() => api.createPerson(schoolId, { displayName }))).ok) {
      form.reset();
    }
  };

  const invite = async (person: ListedPerson) => {
    const sent = await change(() => api.issueInvitation(schoolId, person.id));
    setIssued(sent.ok ? sent.body : null);
  };

  const sheet = (): ReactNode => {
    switch (showing.kind) {
      case "loading":
        return <Sheet {...SHEET} busy />;
      case "not-available":
        return <NotAvailable />;
      case "ready":
        return (
          <PersonsSheet
            persons={showing.records.persons}
            administering={administering}
            busy={busy}
            onAdd={add}
            onInvite={invite}
          />
        );
    }
  };

  /*
   * The issued link is held beside the sheet rather than on it. It is the one
   * thing here the API will never say again, so it must not be torn up by the
   * sheet behind it changing state — including to the not-available state a
   * failed listing brings, which would otherwise strand the Invitation.
   */
  return (
    <>
      {sheet()}
      {issued !== null && <IssuedLink issued={issued} onDone={() => setIssued(null)} />}
    </>
  );
}

/** The Persons as they stand, narrowed to the one being looked for. */
function PersonsSheet({
  persons,
  administering,
  busy,
  onAdd,
  onInvite,
}: {
  persons: ListedPerson[];
  administering: boolean;
  busy: boolean;
  onAdd: (event: FormEvent<HTMLFormElement>) => void;
  onInvite: (person: ListedPerson) => void;
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
      <h1>Persons</h1>
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
        label="Persons"
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
    </Sheet>
  );
}

/**
 * Whether a Person is the one being looked for, by any part of their display
 * name. Matched here rather than asked of the server: the record is a School's
 * Persons, which is as long as a School is, and the whole of it is already on
 * the page.
 */
function matches(person: ListedPerson, looking: string): boolean {
  return person.displayName.toLocaleLowerCase().includes(looking.toLocaleLowerCase());
}

/** How much of the record is in front of you, said so a screen reader hears it change. */
function tally(shown: number, total: number, looking: string): string {
  const persons = `${total} ${total === 1 ? "Person" : "Persons"}`;
  return looking === "" ? persons : `${shown} of ${persons} shown`;
}

/**
 * What the sheet says where no Person is listed. A School with none and a name
 * that matched none are different situations and read differently: the first
 * offers the first action, and the second says what was looked for.
 */
function emptyFor(total: number, looking: string, administering: boolean): string {
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
