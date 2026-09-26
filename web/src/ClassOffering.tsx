import { useCallback, useState, type ComponentProps, type FormEvent } from "react";
import { MAX_NAME_LENGTH } from "../../src/validation/bounds.ts";
import {
  api,
  readAll,
  type ApiResult,
  type ConflictDetail,
  type Enrollment,
  type ListedPerson,
  type Membership,
  type ReachedSchool,
  type TaughtClassOffering as Offering,
  type TeachingAssignment,
} from "./api.ts";
import { ChangeDates } from "./ChangeDates.tsx";
import { ConfirmDialog } from "./Dialog.tsx";
import { Link } from "./Link.tsx";
import { navigate } from "./navigation.ts";
import { NotAvailable } from "./NotAvailable.tsx";
import { courseTitle, labelConflictMessage, offeringName, runsTo } from "./offerings.ts";
import { RecordList } from "./RecordList.tsx";
import { Roster } from "./Roster.tsx";
import { useScreen } from "./screen.ts";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";
import { byName, dayOf, hasEnded, schoolDay } from "./standing.ts";

/** Which sheet this page is, named once so its states cannot drift apart. */
const SHEET: SheetKind = { name: "Class Offering" };

/** A Faculty member who may be assigned now, and the moment their Faculty membership ends, if it does. */
interface Assignable {
  person: ListedPerson;
  endsAt: string | null;
}

/**
 * One Class Offering: the Course it offers, the Term it runs in, the Faculty
 * assigned to teach it, and its roster. It opens from its own URL, so a
 * bookmark to it works.
 *
 * A School Administrator reads it with the ways to assign Faculty, roster
 * Students, change or end either, relabel the offering and delete it. A
 * Faculty member ever assigned to it reads it and changes nothing. A Student
 * ever rostered in it reads it without the roster, which the server does not
 * send them. Anyone else, and an offering that does not exist or is another
 * School's, is the one "not available" state, as any refusal is (ADR-0002).
 */
export function ClassOffering({ school, classOfferingId }: { school: ReachedSchool; classOfferingId: string }) {
  const { schoolId } = school;
  const administers = school.roles.includes("school_administrator");
  // Stable for as long as the page shows one offering, so it is read once and again only after a change.
  const read = useCallback(
    async (schoolId: string) => {
      if (!administers) {
        const answered = await api.classOffering(schoolId, classOfferingId);
        return answered.ok ? { ok: true as const, body: { ...answered.body, assignable: [], rosterable: [] } } : answered;
      }
      const answered = await readAll([
        api.classOffering(schoolId, classOfferingId),
        api.memberships(schoolId),
        api.persons(schoolId),
        api.enrollments(schoolId),
      ]);
      if (!answered.ok) {
        return answered;
      }
      const [{ classOffering }, { memberships }, { persons }, { enrollments }] = answered.body;
      return {
        ok: true as const,
        body: {
          classOffering,
          assignable: assignableFaculty(memberships, persons),
          rosterable: rosterableStudents(classOffering, enrollments, persons),
        },
      };
    },
    [classOfferingId, administers],
  );
  const { showing, busy, change } = useScreen(schoolId, read);
  /** Held apart from the screen's own: a deleted offering is not read again, which would find it gone. */
  const [deleting, setDeleting] = useState(false);

  switch (showing.kind) {
    case "loading":
      return <Sheet {...SHEET} busy />;
    case "not-available":
      return <NotAvailable />;
    case "ready":
      return (
        <OfferingSheet
          schoolId={schoolId}
          administers={administers}
          offering={showing.records.classOffering}
          assignable={showing.records.assignable}
          rosterable={showing.records.rosterable}
          busy={busy || deleting}
          onAssign={(assignment) => change(() => api.assignTeaching(schoolId, classOfferingId, assignment))}
          onChangeDates={(assignment, bounds) =>
            change(() => api.changeTeachingAssignment(schoolId, assignment.id, bounds))
          }
          onEnd={(assignment) => change(() => api.endTeachingAssignment(schoolId, assignment.id))}
          onRoster={(rostering) => change(() => api.rosterStudents(schoolId, classOfferingId, rostering))}
          onChangeRosterDates={(membership, bounds) =>
            change(() => api.changeRosterMembership(schoolId, membership.id, bounds))
          }
          onEndRoster={(membership) => change(() => api.endRosterMembership(schoolId, membership.id))}
          onRelabel={(label) => change(() => api.relabelClassOffering(schoolId, classOfferingId, label))}
          onDelete={async () => {
            setDeleting(true);
            const sent = await api.deleteClassOffering(schoolId, classOfferingId);
            if (sent.ok) {
              navigate({ name: "classOfferings", schoolId }, { replace: true });
              return sent;
            }
            setDeleting(false);
            // Settled as any failed change is, so it shows what every other failure shows.
            return change(async () => sent);
          }}
        />
      );
  }
}

/** The Persons holding a Faculty membership in force now, by name: the only ones the server assigns. */
function assignableFaculty(memberships: Membership[], persons: ListedPerson[]): Assignable[] {
  const now = new Date();
  const byId = new Map(persons.map((person) => [person.id, person]));
  return memberships
    .filter(
      (membership) =>
        membership.role === "faculty" && new Date(membership.startsAt) <= now && !hasEnded(membership, now),
    )
    .flatMap((membership) => {
      const person = byId.get(membership.personId);
      return person === undefined ? [] : [{ person, endsAt: membership.endsAt }];
    })
    .sort(byName((each) => each.person.displayName));
}

/**
 * The Students with an open Enrollment who are not on this roster to the
 * Term's last day, by name. One who left part way through may be rostered
 * again; the dialog holds back dates that would overlap what they held, so one
 * Student never refuses the whole request.
 */
function rosterableStudents(offering: Offering, enrollments: Enrollment[], persons: ListedPerson[]): ListedPerson[] {
  const enrolled = new Set(
    enrollments.filter((enrollment) => enrollment.endedAt === null).map((enrollment) => enrollment.studentPersonId),
  );
  const toTermEnd = new Set(
    (offering.rosterMemberships ?? [])
      .filter((membership) => runsTo(membership, offering.term) >= offering.term.lastDate)
      .map((membership) => membership.person.id),
  );
  return persons
    .filter((person) => enrolled.has(person.id) && !toTermEnd.has(person.id))
    .sort(byName((person) => person.displayName));
}

/** What is waiting on a confirmation: which assignment, and which of the two changes to it. */
type Confirming = { kind: "dates" | "end"; assignment: TeachingAssignment };

function OfferingSheet({
  schoolId,
  administers,
  offering,
  assignable,
  rosterable,
  busy,
  onAssign,
  onChangeDates,
  onEnd,
  onRoster,
  onChangeRosterDates,
  onEndRoster,
  onRelabel,
  onDelete,
}: {
  schoolId: string;
  administers: boolean;
  offering: Offering;
  assignable: Assignable[];
  rosterable: ListedPerson[];
  busy: boolean;
  onAssign: (assignment: { personId: string; firstDate?: string; lastDate?: string }) => Promise<ApiResult<unknown>>;
  onChangeDates: (
    assignment: TeachingAssignment,
    bounds: { firstDate: string; lastDate: string | null },
  ) => Promise<ApiResult<unknown>>;
  onEnd: (assignment: TeachingAssignment) => Promise<ApiResult<unknown>>;
  onRoster: ComponentProps<typeof Roster>["onRoster"];
  onChangeRosterDates: ComponentProps<typeof Roster>["onChangeDates"];
  onEndRoster: ComponentProps<typeof Roster>["onEnd"];
  onRelabel: (label: string | null) => Promise<ApiResult<unknown>>;
  onDelete: () => Promise<ApiResult<unknown>>;
}) {
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [assignProblem, setAssignProblem] = useState<string | null>(null);
  /** What the last change did, said once so a screen reader hears it land. */
  const [done, setDone] = useState("");
  const [chosen, setChosen] = useState("");
  const { course, term } = offering;
  const today = dayOf(new Date());
  /** The last day an assignment runs to: its own, or its Term's while it is open. */
  const runsTo = (assignment: TeachingAssignment) => assignment.lastDate ?? term.lastDate;
  const whose = (assignment: TeachingAssignment) => `${assignment.person.displayName}’s Teaching assignment`;
  const leaving = assignable.find((each) => each.person.id === chosen)?.endsAt ?? null;

  const settle = (sent: ApiResult<unknown>, success: string, show: (message: string) => void) => {
    if (sent.ok) {
      setDone(success);
    } else if (sent.conflict !== undefined) {
      show(assignmentConflictMessage(sent.conflict));
    }
  };

  const assign = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const personId = String(fields.get("personId") ?? "");
    const firstDate = String(fields.get("firstDate") ?? "");
    const lastDate = String(fields.get("lastDate") ?? "");
    if (personId === "") {
      return;
    }
    setAssignProblem(null);
    setDone("");
    const name = assignable.find((each) => each.person.id === personId)?.person.displayName ?? "The Faculty member";
    const sent = await onAssign({
      personId,
      ...(firstDate === "" ? {} : { firstDate }),
      ...(lastDate === "" ? {} : { lastDate }),
    });
    if (sent.ok) {
      form.reset();
      setChosen("");
    }
    settle(sent, `${name} is assigned to teach ${offeringName(offering)}.`, setAssignProblem);
  };

  const relabel = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const label = String(new FormData(event.currentTarget).get("label") ?? "").trim();
    setProblem(null);
    setDone("");
    const sent = await onRelabel(label === "" ? null : label);
    if (sent.ok) {
      setDone(label === "" ? "The label is removed." : `The label is now ${label}.`);
    } else if (sent.conflict !== undefined) {
      setProblem(labelConflictMessage(sent.conflict, course.name, term.name));
    }
  };

  const legend = (
    <>
      <h2>Key</h2>
      <p>One Course, offered for one Term, who teaches it, and who is in it.</p>
      <dl>
        <Key term="Class Offering">
          A Course offered for one Term. Offering it in another Term is another Class Offering.
        </Key>
        <Key term="Label">What tells this offering apart from the Course&rsquo;s others in the same Term.</Key>
        <Key term="Teaching assignment">
          One Faculty member teaching this offering, from one School date to another inside its Term. Several may teach
          it at once.
        </Key>
        {offering.rosterMemberships !== undefined && (
          <Key term="Roster membership">
            One Student in this offering, from one School date to another inside its Term.
          </Key>
        )}
        <Key term="End of Term">Still open: it runs until the Term&rsquo;s last day.</Key>
      </dl>
    </>
  );

  return (
    <Sheet
      {...SHEET}
      legend={legend}
      foot={
        <p>
          {administers ? (
            <Link to={{ name: "classOfferings", schoolId }}>All Class Offerings</Link>
          ) : (
            <Link to={{ name: "classes", schoolId }}>Your classes</Link>
          )}
        </p>
      }
    >
      <h1>{offeringName(offering)}</h1>
      <dl className="facts">
        <dt>Course</dt>
        <dd>{courseTitle(course)}</dd>
        <dt>Term</dt>
        <dd>
          {term.name}, {term.academicYear.name}
        </dd>
        <dt>Runs</dt>
        <dd>
          {schoolDay(term.firstDate)} to {schoolDay(term.lastDate)}
        </dd>
        <dt>Label</dt>
        <dd>{offering.label ?? <span className="muted">None</span>}</dd>
      </dl>
      <p className="muted" role="status">
        {done}
      </p>

      <section>
        <h2>Teaching assignments</h2>
        <RecordList
          label="Teaching assignments"
          rows={offering.teachingAssignments}
          keyOf={(assignment) => assignment.id}
          empty={`No Faculty member is assigned to teach this offering yet.${administers ? " Assign one below." : ""}`}
          columns={[
            { head: "Faculty", cell: (assignment) => assignment.person.displayName },
            {
              head: "From",
              cell: (assignment) =>
                assignment.firstDate > today ? (
                  <>
                    <span className="mark mark--open">Starts later</span> {schoolDay(assignment.firstDate)}
                  </>
                ) : (
                  schoolDay(assignment.firstDate)
                ),
            },
            {
              head: "Until",
              cell: (assignment) =>
                runsTo(assignment) < today ? (
                  <>
                    <span className="mark mark--struck">Ended</span> {schoolDay(runsTo(assignment))}
                  </>
                ) : assignment.lastDate === null ? (
                  <span className="mark">End of Term</span>
                ) : (
                  schoolDay(assignment.lastDate)
                ),
            },
            ...(administers
              ? [
                  {
                    head: "Change",
                    actions: true,
                    cell: (assignment: TeachingAssignment) =>
                      runsTo(assignment) < today ? null : (
                        <span className="actions record__buttons">
                          <button
                            type="button"
                            className="button-quiet"
                            disabled={busy}
                            aria-label={`Change the dates of ${whose(assignment)}`}
                            onClick={() => setConfirming({ kind: "dates", assignment })}
                          >
                            Change dates
                          </button>
                          <button
                            type="button"
                            className="button-stamp"
                            disabled={busy}
                            aria-label={`End ${whose(assignment)}`}
                            onClick={() => setConfirming({ kind: "end", assignment })}
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
      </section>

      {administers && (
        <>
          <form onSubmit={assign} aria-label="Assign Faculty to this Class Offering">
            <h2>Assign Faculty</h2>
            {assignable.length === 0 ? (
              <p className="empty">
                No one holds a Faculty membership in force. Grant one on{" "}
                <Link to={{ name: "memberships", schoolId }}>Roles</Link> first.
              </p>
            ) : (
              <>
                <label>
                  Faculty member
                  <select
                    name="personId"
                    required
                    value={chosen}
                    onChange={(event) => setChosen(event.currentTarget.value)}
                  >
                    <option value="" disabled>
                      Choose a Faculty member
                    </option>
                    {assignable.map(({ person }) => (
                      <option key={person.id} value={person.id}>
                        {person.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  From (optional)
                  <input type="date" name="firstDate" min={term.firstDate} max={term.lastDate} />
                </label>
                <label>
                  Until (optional)
                  <input
                    type="date"
                    name="lastDate"
                    min={term.firstDate}
                    max={leaving === null ? term.lastDate : [term.lastDate, dayOf(new Date(leaving))].sort()[0]}
                  />
                </label>
                <p className="muted">
                  Left blank, the assignment runs with the Term, from its first day to its last.
                  {leaving !== null &&
                    ` This Faculty membership ends on ${schoolDay(dayOf(new Date(leaving)))}, so the assignment ends by then.`}
                </p>
                {assignProblem !== null && (
                  <p role="alert" className="error">
                    {assignProblem}
                  </p>
                )}
                <button type="submit" disabled={busy}>
                  Assign
                </button>
              </>
            )}
          </form>
        </>
      )}

      {offering.rosterMemberships !== undefined && (
        <Roster
          schoolId={schoolId}
          administers={administers}
          offering={offering}
          roster={offering.rosterMemberships}
          rosterable={rosterable}
          busy={busy}
          onRoster={onRoster}
          onChangeDates={onChangeRosterDates}
          onEnd={onEndRoster}
        />
      )}

      {administers && (
        <>
          <form onSubmit={relabel} aria-label="Relabel this Class Offering">
            <h2>Relabel</h2>
            <label>
              Label (optional)
              <input
                // Keyed by the label as it stands, so the field shows it afresh once a change lands.
                key={offering.label ?? ""}
                name="label"
                maxLength={MAX_NAME_LENGTH}
                autoComplete="off"
                defaultValue={offering.label ?? ""}
              />
            </label>
            {problem !== null && (
              <p role="alert" className="error">
                {problem}
              </p>
            )}
            <p className="actions">
              <button type="submit" disabled={busy}>
                Save label
              </button>
              <button type="button" className="button-stamp" disabled={busy} onClick={() => setDeleting(true)}>
                Delete Class Offering
              </button>
            </p>
          </form>
        </>
      )}

      {confirming?.kind === "dates" && (
        <ChangeDates
          held={confirming.assignment}
          whose={whose(confirming.assignment)}
          term={term}
          busy={busy}
          onCancel={() => setConfirming(null)}
          onSave={async (bounds) => {
            const { assignment } = confirming;
            setConfirming(null);
            setDone("");
            setAssignProblem(null);
            const sent = await onChangeDates(assignment, bounds);
            settle(sent, `The dates of ${whose(assignment)} are changed.`, setAssignProblem);
          }}
        />
      )}
      {confirming?.kind === "end" && (
        <ConfirmDialog
          title={
            confirming.assignment.firstDate > today
              ? `Remove ${whose(confirming.assignment)}?`
              : `End ${whose(confirming.assignment)}?`
          }
          confirm={confirming.assignment.firstDate > today ? "Remove the assignment" : "End the assignment"}
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            const { assignment } = confirming;
            setConfirming(null);
            setDone("");
            const sent = await onEnd(assignment);
            settle(sent, `${whose(assignment)} is ended.`, setAssignProblem);
          }}
        >
          {confirming.assignment.firstDate > today ? (
            <p>
              It has not begun, so it is removed: {confirming.assignment.person.displayName} will not have taught{" "}
              {offeringName(offering)} at all.
            </p>
          ) : (
            <p>
              {confirming.assignment.person.displayName} teaches {offeringName(offering)} until the end of today. The
              assignment stays on this sheet as ended, as the record of who taught it and when.
            </p>
          )}
        </ConfirmDialog>
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${offeringName(offering)}?`}
          confirm="Delete the Class Offering"
          busy={busy}
          onCancel={() => setDeleting(false)}
          onConfirm={async () => {
            setDeleting(false);
            setDone("");
            setProblem(null);
            const sent = await onDelete();
            if (!sent.ok && sent.conflict !== undefined) {
              setProblem(assignmentConflictMessage(sent.conflict));
            }
          }}
        >
          <p>
            {course.name} is no longer offered in {term.name} under this offering. The Course and the Term stay as they
            are.
          </p>
        </ConfirmDialog>
      )}
    </Sheet>
  );
}

/** Why an assignment was not made or changed, or the offering not deleted, in the words of the rule. */
function assignmentConflictMessage(conflict: ConflictDetail): string {
  switch (conflict.conflict) {
    case "teaching_assignment_overlap":
      return "That Faculty member is already assigned to this offering for some of those days. Their assignments to it cannot overlap.";
    case "teaching_assignment_outside_term":
      return "Those days fall outside the Term. A Teaching assignment runs between the Term’s first and last days.";
    case "dependent":
      return conflict.dependent === "roster_membership"
        ? "Students have been rostered in this offering, and it is not deleted once they have: the memberships are the record of who was in the class."
        : "Faculty have been assigned to this offering, and it is not deleted once they have: the assignments are the record of who taught it.";
    default:
      return "That change could not be made.";
  }
}
