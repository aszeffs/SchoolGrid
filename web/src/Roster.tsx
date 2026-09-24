import { useState } from "react";
import type { ApiResult, ConflictDetail, ListedPerson, RosterMembership, TaughtClassOffering } from "./api.ts";
import { ChangeDates } from "./ChangeDates.tsx";
import { ConfirmDialog } from "./Dialog.tsx";
import { Link } from "./Link.tsx";
import { offeringName } from "./offerings.ts";
import { RecordList } from "./RecordList.tsx";
import { dayOf, schoolDay } from "./standing.ts";

/** What is waiting on a confirmation: which membership, and which of the two changes to it. */
type Confirming = { kind: "dates" | "end"; membership: RosterMembership };

/**
 * A Class Offering's roster: every Student on it, with the days they are on it.
 *
 * A School Administrator reads it with the ways to roster Students, several at
 * once, and to change or end a membership. Faculty ever assigned to the
 * offering read it and change nothing. A Student is never shown one: the
 * server leaves it out of what they are served.
 */
export function Roster({
  schoolId,
  administers,
  offering,
  roster,
  rosterable,
  busy,
  onRoster,
  onChangeDates,
  onEnd,
}: {
  schoolId: string;
  administers: boolean;
  offering: TaughtClassOffering;
  roster: RosterMembership[];
  /** The Students who may be rostered now: enrolled, and not on this roster already. */
  rosterable: ListedPerson[];
  busy: boolean;
  onRoster: (rostering: { personIds: string[]; firstDate?: string; lastDate?: string }) => Promise<ApiResult<unknown>>;
  onChangeDates: (
    membership: RosterMembership,
    bounds: { firstDate: string; lastDate: string | null },
  ) => Promise<ApiResult<unknown>>;
  onEnd: (membership: RosterMembership) => Promise<ApiResult<unknown>>;
}) {
  const [rostering, setRostering] = useState(false);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** What the last change did, said once so a screen reader hears it land. */
  const [done, setDone] = useState("");
  const { term } = offering;
  const today = dayOf(new Date());
  /** The last day a membership runs to: its own, or its Term's while it is open. */
  const runsTo = (membership: RosterMembership) => membership.lastDate ?? term.lastDate;
  const whose = (membership: RosterMembership) => `${membership.person.displayName}’s Roster membership`;

  const settle = (sent: ApiResult<unknown>, success: string) => {
    if (sent.ok) {
      setDone(success);
    } else if (sent.conflict !== undefined) {
      setProblem(rosterConflictMessage(sent.conflict));
    }
  };

  return (
    <section>
      <h2>Roster</h2>
      <p className="muted" role="status">
        {done}
      </p>
      <RecordList
        label="Roster"
        rows={roster}
        keyOf={(membership) => membership.id}
        empty={`No Student is on this roster yet.${administers ? " Roster some below." : ""}`}
        columns={[
          { head: "Student", cell: (membership) => membership.person.displayName },
          {
            head: "From",
            cell: (membership) =>
              membership.firstDate > today ? (
                <>
                  <span className="mark mark--open">Starts later</span> {schoolDay(membership.firstDate)}
                </>
              ) : (
                schoolDay(membership.firstDate)
              ),
          },
          {
            head: "Until",
            cell: (membership) =>
              runsTo(membership) < today ? (
                <>
                  <span className="mark mark--struck">Ended</span> {schoolDay(runsTo(membership))}
                </>
              ) : membership.lastDate === null ? (
                <span className="mark">End of Term</span>
              ) : (
                schoolDay(membership.lastDate)
              ),
          },
          ...(administers
            ? [
                {
                  head: "Change",
                  actions: true,
                  cell: (membership: RosterMembership) =>
                    runsTo(membership) < today ? null : (
                      <span className="actions record__buttons">
                        <button
                          type="button"
                          className="button-quiet"
                          disabled={busy}
                          aria-label={`Change the dates of ${whose(membership)}`}
                          onClick={() => setConfirming({ kind: "dates", membership })}
                        >
                          Change dates
                        </button>
                        <button
                          type="button"
                          className="button-stamp"
                          disabled={busy}
                          aria-label={`End ${whose(membership)}`}
                          onClick={() => setConfirming({ kind: "end", membership })}
                        >
                          End
                        </button>
                      </span>
                    ),
                },
              ]
            : []),
        ]}
      />
      {problem !== null && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}

      {administers &&
        (rosterable.length === 0 ? (
          <p className="empty">
            Every Student with an open Enrollment is on this roster already. To roster someone else, start their
            Enrollment on <Link to={{ name: "enrollments", schoolId }}>Enrollments</Link> first.
          </p>
        ) : (
          <p>
            <button type="button" disabled={busy} onClick={() => setRostering(true)}>
              Roster Students
            </button>
          </p>
        ))}

      {rostering && (
        <RosterStudents
          offering={offering}
          rosterable={rosterable}
          busy={busy}
          onCancel={() => setRostering(false)}
          onRoster={async (request) => {
            setRostering(false);
            setDone("");
            setProblem(null);
            const sent = await onRoster(request);
            const count = request.personIds.length === 1 ? "1 Student is" : `${request.personIds.length} Students are`;
            settle(sent, `${count} rostered in ${offeringName(offering)}.`);
          }}
        />
      )}
      {confirming?.kind === "dates" && (
        <ChangeDates
          held={confirming.membership}
          whose={whose(confirming.membership)}
          term={term}
          busy={busy}
          onCancel={() => setConfirming(null)}
          onSave={async (bounds) => {
            const { membership } = confirming;
            setConfirming(null);
            setDone("");
            setProblem(null);
            settle(await onChangeDates(membership, bounds), `The dates of ${whose(membership)} are changed.`);
          }}
        />
      )}
      {confirming?.kind === "end" && (
        <ConfirmDialog
          title={
            confirming.membership.firstDate > today
              ? `Remove ${whose(confirming.membership)}?`
              : `End ${whose(confirming.membership)}?`
          }
          confirm={confirming.membership.firstDate > today ? "Remove the membership" : "End the membership"}
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            const { membership } = confirming;
            setConfirming(null);
            setDone("");
            setProblem(null);
            settle(await onEnd(membership), `${whose(membership)} is ended.`);
          }}
        >
          {confirming.membership.firstDate > today ? (
            <p>
              It has not begun, so it is removed: {confirming.membership.person.displayName} will not have been on the
              roster of {offeringName(offering)} at all.
            </p>
          ) : (
            <p>
              {confirming.membership.person.displayName} stays on the roster of {offeringName(offering)} until the end
              of today. The membership stays on this sheet as ended, as the record of who was in the class and when.
            </p>
          )}
        </ConfirmDialog>
      )}
    </section>
  );
}

/**
 * The rostering dialog: every Student who may be rostered, found by name and
 * ticked, as many as the class needs, and rostered in one request. Nothing is
 * sent until it is confirmed, and one Student who cannot be rostered leaves
 * every other unrostered too.
 *
 * Native checkboxes in a fieldset, and a search field above them, so it is
 * worked from the keyboard like any form: Tab between the fields, Space to
 * tick.
 */
function RosterStudents({
  offering,
  rosterable,
  busy,
  onCancel,
  onRoster,
}: {
  offering: TaughtClassOffering;
  rosterable: ListedPerson[];
  busy: boolean;
  onCancel: () => void;
  onRoster: (request: { personIds: string[]; firstDate?: string; lastDate?: string }) => void;
}) {
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [firstDate, setFirstDate] = useState("");
  const [lastDate, setLastDate] = useState("");
  const { term } = offering;
  const looking = query.trim().toLocaleLowerCase();
  const shown = rosterable.filter((person) => person.displayName.toLocaleLowerCase().includes(looking));
  const inOrder = firstDate === "" || lastDate === "" || lastDate >= firstDate;
  const count = chosen.size === 1 ? "1 Student" : `${chosen.size} Students`;

  const toggle = (personId: string, on: boolean) =>
    setChosen((was) => {
      const next = new Set(was);
      if (on) {
        next.add(personId);
      } else {
        next.delete(personId);
      }
      return next;
    });

  return (
    <ConfirmDialog
      title={`Roster Students in ${offeringName(offering)}`}
      confirm={chosen.size === 0 ? "Roster Students" : `Roster ${count}`}
      busy={busy || chosen.size === 0 || !inOrder}
      onCancel={onCancel}
      onConfirm={() =>
        onRoster({
          // In the order they are listed, whatever order they were ticked in.
          personIds: rosterable.filter((person) => chosen.has(person.id)).map((person) => person.id),
          ...(firstDate === "" ? {} : { firstDate }),
          ...(lastDate === "" ? {} : { lastDate }),
        })
      }
    >
      <p>Only Students with an open Enrollment who are not on this roster already are listed.</p>
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
      <fieldset>
        <legend>Students</legend>
        {shown.length === 0 ? (
          <p className="empty">No Student listed here has that in their name.</p>
        ) : (
          shown.map((person) => (
            <label key={person.id} className="check">
              <input
                type="checkbox"
                checked={chosen.has(person.id)}
                onChange={(event) => toggle(person.id, event.currentTarget.checked)}
              />
              {person.displayName}
            </label>
          ))
        )}
      </fieldset>
      <p className="muted" role="status">
        {chosen.size === 0 ? "No Student chosen yet." : `${count} chosen.`}
      </p>
      <label>
        From (optional)
        <input
          type="date"
          name="firstDate"
          min={term.firstDate}
          max={term.lastDate}
          value={firstDate}
          onChange={(event) => setFirstDate(event.currentTarget.value)}
        />
      </label>
      <label>
        Until (optional)
        <input
          type="date"
          name="lastDate"
          min={firstDate === "" ? term.firstDate : firstDate}
          max={term.lastDate}
          value={lastDate}
          onChange={(event) => setLastDate(event.currentTarget.value)}
        />
      </label>
      <p className="muted">Left blank, each membership runs with the Term, from its first day to its last.</p>
    </ConfirmDialog>
  );
}

/** Why Students were not rostered, or a membership not changed, in the words of the rule. */
function rosterConflictMessage(conflict: ConflictDetail): string {
  switch (conflict.conflict) {
    case "roster_membership_overlap":
      return "A Student chosen is already on this roster for some of those days, so no one was rostered. A Student’s memberships of one offering cannot overlap.";
    case "roster_membership_outside_term":
      return "Those days fall outside the Term. A Roster membership runs between the Term’s first and last days.";
    default:
      return "That change could not be made.";
  }
}
