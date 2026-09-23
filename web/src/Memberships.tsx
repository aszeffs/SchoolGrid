import { useState, type FormEvent } from "react";
import { api, readAll, type ListedPerson, type Membership, type ReachedSchool, type Role } from "./api.ts";
import { ConfirmDialog } from "./Dialog.tsx";
import { NotAvailable } from "./NotAvailable.tsx";
import { RecordList } from "./RecordList.tsx";
import { ROLE_NAMES, ROLES } from "./roles.ts";
import { useScreen } from "./screen.ts";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";
import { byName, dayAfter, hasEnded, MOMENT, namesOf, startOfDay } from "./standing.ts";

/** Which sheet this page is, named once so its states cannot drift apart. */
const SHEET: SheetKind = { name: "School memberships" };

/** A School's memberships, with the Persons they are held by so each can be named. */
async function list(schoolId: string) {
  const answered = await readAll([api.memberships(schoolId), api.persons(schoolId)]);
  if (!answered.ok) {
    return answered;
  }
  const [{ memberships }, { persons }] = answered.body;
  return { ok: true as const, body: { memberships, persons } };
}

/** What is waiting on a confirmation: which membership, and which of the two changes to it. */
type Confirming = { kind: "narrow" | "revoke"; membership: Membership };

/**
 * Every School membership in the School, and the way to grant one, narrow one
 * and revoke one.
 *
 * Each membership is a row of its own. A Person holding several — Faculty and
 * Guardian, say — holds several rows, and each is narrowed or revoked alone:
 * nothing here acts on a Person, only on one of the roles they hold.
 */
export function Memberships({ school }: { school: ReachedSchool }) {
  const { schoolId } = school;
  const { showing, busy, change } = useScreen(schoolId, list);

  switch (showing.kind) {
    case "loading":
      return <Sheet {...SHEET} busy />;
    case "not-available":
      return <NotAvailable />;
    case "ready":
      return (
        <MembershipsSheet
          {...showing.records}
          busy={busy}
          onGrant={(grant) => change(() => api.grantMembership(schoolId, grant))}
          onNarrow={(membership, endsAt) => change(() => api.narrowMembership(schoolId, membership.id, endsAt))}
          onRevoke={(membership) => change(() => api.revokeMembership(schoolId, membership.id))}
        />
      );
  }
}

function MembershipsSheet({
  memberships,
  persons,
  busy,
  onGrant,
  onNarrow,
  onRevoke,
}: {
  memberships: Membership[];
  persons: ListedPerson[];
  busy: boolean;
  onGrant: (grant: { personId: string; role: Role; endsAt?: string }) => Promise<{ ok: boolean }>;
  onNarrow: (membership: Membership, endsAt: string) => void;
  onRevoke: (membership: Membership) => void;
}) {
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const now = new Date();
  const nameOf = namesOf(persons);
  const ordered = [...memberships].sort(byName((membership) => nameOf(membership.personId)));
  const held = ordered.filter((membership) => !hasEnded(membership, now));
  const ended = ordered.filter((membership) => hasEnded(membership, now));
  /** Names one membership among a Person's several, so a control says which of them it acts on. */
  const whose = (membership: Membership) => `${nameOf(membership.personId)}’s ${ROLE_NAMES[membership.role]} membership`;

  const grant = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const personId = String(fields.get("personId") ?? "");
    const role = String(fields.get("role") ?? "") as Role;
    const endsOn = String(fields.get("endsOn") ?? "");
    if (personId === "" || !ROLES.includes(role)) {
      return;
    }
    const sent = await onGrant({ personId, role, ...(endsOn === "" ? {} : { endsAt: startOfDay(endsOn) }) });
    if (sent.ok) {
      form.reset();
    }
  };

  const legend = (
    <>
      <h2>Key</h2>
      <p>Every role held in this School, one row per role.</p>
      <dl>
        <Key term="School membership">
          One role one Person holds here, with its own start and end. A Person holding several has each listed, and
          each managed, on its own.
        </Key>
        <Key term="Starts later">Granted, and not in force until the moment it starts.</Key>
        <Key term="Narrow">Sets when the membership ends. Until then, nothing about it changes.</Key>
        <Key term="Revoke">
          Ends the membership now. The row stays on this sheet as ended, because it is the record of when the role was
          held.
        </Key>
      </dl>
    </>
  );

  return (
    <Sheet {...SHEET} legend={legend}>
      <h1>School memberships</h1>
      <RecordList
        label="School memberships in force"
        rows={held}
        keyOf={(membership) => membership.id}
        empty="No School membership is in force. Grant the first one below."
        columns={[
          { head: "Person", cell: (membership) => nameOf(membership.personId) },
          { head: "Role", cell: (membership) => ROLE_NAMES[membership.role] },
          {
            head: "From",
            cell: (membership) =>
              new Date(membership.startsAt) > now ? (
                <>
                  <span className="mark mark--open">Starts later</span> {MOMENT.format(new Date(membership.startsAt))}
                </>
              ) : (
                MOMENT.format(new Date(membership.startsAt))
              ),
          },
          {
            head: "Until",
            cell: (membership) =>
              membership.endsAt === null ? <span className="mark">No end</span> : MOMENT.format(new Date(membership.endsAt)),
          },
          {
            head: "Change",
            actions: true,
            cell: (membership) => (
              <span className="actions record__buttons">
                <button
                  type="button"
                  className="button-quiet"
                  disabled={busy}
                  aria-label={`Narrow ${whose(membership)}`}
                  onClick={() => setConfirming({ kind: "narrow", membership })}
                >
                  Narrow
                </button>
                <button
                  type="button"
                  className="button-stamp"
                  disabled={busy}
                  aria-label={`Revoke ${whose(membership)}`}
                  onClick={() => setConfirming({ kind: "revoke", membership })}
                >
                  Revoke
                </button>
              </span>
            ),
          },
        ]}
      />

      <form onSubmit={grant} aria-label="Grant a School membership">
        <h2>Grant a School membership</h2>
        <label>
          Person
          <select name="personId" required defaultValue="">
            <option value="" disabled>
              Choose a Person
            </option>
            {[...persons].sort(byName((person) => person.displayName)).map((person) => (
              <option key={person.id} value={person.id}>
                {person.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Role
          <select name="role" required defaultValue="">
            <option value="" disabled>
              Choose a role
            </option>
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_NAMES[role]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Ends on (optional)
          <input type="date" name="endsOn" min={dayAfter(now)} />
        </label>
        <p className="muted">It is in force from now. Left without an end, it holds until it is narrowed or revoked.</p>
        <button type="submit" disabled={busy}>
          Grant membership
        </button>
      </form>

      <section>
        <h2>Ended</h2>
        <RecordList
          label="Ended School memberships"
          rows={ended}
          keyOf={(membership) => membership.id}
          empty="No School membership in this School has ended."
          columns={[
            { head: "Person", cell: (membership) => nameOf(membership.personId) },
            { head: "Role", cell: (membership) => ROLE_NAMES[membership.role] },
            { head: "From", cell: (membership) => MOMENT.format(new Date(membership.startsAt)) },
            { head: "Ended", cell: (membership) => MOMENT.format(new Date(membership.endsAt!)) },
          ]}
        />
      </section>

      {confirming?.kind === "narrow" && (
        <Narrow
          membership={confirming.membership}
          whose={whose(confirming.membership)}
          name={nameOf(confirming.membership.personId)}
          busy={busy}
          onCancel={() => setConfirming(null)}
          onNarrow={(endsAt) => {
            setConfirming(null);
            onNarrow(confirming.membership, endsAt);
          }}
        />
      )}
      {confirming?.kind === "revoke" && (
        <ConfirmDialog
          title="Revoke this School membership?"
          confirm="Revoke the membership"
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            onRevoke(confirming.membership);
          }}
        >
          <p>
            {nameOf(confirming.membership.personId)} stops holding {ROLE_NAMES[confirming.membership.role]} in this
            School now, and loses whatever that role reaches.
          </p>
          <p>
            Any other School membership {nameOf(confirming.membership.personId)} holds stays as it is. This one stays
            on the record, as ended, and cannot be reopened: to give the role back, grant it again.
          </p>
        </ConfirmDialog>
      )}
    </Sheet>
  );
}

/** Asks when a membership is to end, and names what that does before it is set. */
function Narrow({
  membership,
  whose,
  name,
  busy,
  onCancel,
  onNarrow,
}: {
  membership: Membership;
  whose: string;
  name: string;
  busy: boolean;
  onCancel: () => void;
  onNarrow: (endsAt: string) => void;
}) {
  const [endsOn, setEndsOn] = useState("");
  // Not before tomorrow, and not before it starts: the server refuses an end
  // already gone by, which would claim access was not held when it was.
  const earliest = [dayAfter(new Date()), dayAfter(new Date(membership.startsAt))].sort().at(-1)!;
  return (
    <ConfirmDialog
      title="Narrow this School membership?"
      confirm="Set the end"
      busy={busy || endsOn === "" || endsOn < earliest}
      onCancel={onCancel}
      onConfirm={() => onNarrow(startOfDay(endsOn))}
    >
      <p>
        Sets when {whose} ends. {name} holds the role until the start of that day and loses whatever it reaches then.
        Any other School membership {name} holds is not touched.
      </p>
      <label>
        Ends on
        <input
          type="date"
          name="endsOn"
          required
          min={earliest}
          value={endsOn}
          onChange={(event) => setEndsOn(event.currentTarget.value)}
        />
      </label>
    </ConfirmDialog>
  );
}
