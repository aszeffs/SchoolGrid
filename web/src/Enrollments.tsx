import { useState, type FormEvent } from "react";
import { MAX_REASON_LENGTH } from "../../src/validation/bounds.ts";
import { api, readAll, type Enrollment, type GuardianLink, type ReachedSchool } from "./api.ts";
import { ConfirmDialog } from "./Dialog.tsx";
import { Link } from "./Link.tsx";
import { NotAvailable } from "./NotAvailable.tsx";
import { RecordList } from "./RecordList.tsx";
import { useScreen } from "./screen.ts";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";
import { byName, DAY, holdingNowOrLater, namesOf } from "./standing.ts";

/** Which sheet this page is, named once so its states cannot drift apart. */
const SHEET: SheetKind = { name: "Enrollments" };

/**
 * A School's Enrollments, and what ending one would reach: the Persons to name
 * them by, the memberships that say who may be enrolled, and the Guardian
 * links an ending also ends, so the confirmation can count them.
 */
async function list(schoolId: string) {
  const answered = await readAll([
    api.enrollments(schoolId),
    api.persons(schoolId),
    api.memberships(schoolId),
    api.guardianLinks(schoolId),
  ]);
  if (!answered.ok) {
    return answered;
  }
  const [{ enrollments }, { persons }, { memberships }, { guardianLinks }] = answered.body;
  return { ok: true as const, body: { enrollments, persons, memberships, guardianLinks } };
}

type Records = Extract<Awaited<ReturnType<typeof list>>, { ok: true }>["body"];

/**
 * Every Enrollment in the School, the way to start one and the way to end one.
 *
 * Ending one is the most consequential thing the app does. It is departure: the
 * Student's open Roster memberships end, every Guardian link to them ends, and
 * the Student's own access narrows to their published records. Nothing is
 * removed. The confirmation says all of that, with the counts, before it will
 * go ahead.
 */
export function Enrollments({ school }: { school: ReachedSchool }) {
  const { schoolId } = school;
  const { showing, busy, change } = useScreen(schoolId, list);

  switch (showing.kind) {
    case "loading":
      return <Sheet {...SHEET} busy />;
    case "not-available":
      return <NotAvailable />;
    case "ready":
      return (
        <EnrollmentsSheet
          records={showing.records}
          schoolId={schoolId}
          busy={busy}
          onEnroll={(studentPersonId) => change(() => api.enroll(schoolId, studentPersonId))}
          onEnd={(enrollment, reason) => change(() => api.endEnrollment(schoolId, enrollment.id, reason))}
        />
      );
  }
}

function EnrollmentsSheet({
  records: { enrollments, persons, memberships, guardianLinks },
  schoolId,
  busy,
  onEnroll,
  onEnd,
}: {
  records: Records;
  schoolId: string;
  busy: boolean;
  onEnroll: (studentPersonId: string) => Promise<{ ok: boolean }>;
  onEnd: (enrollment: Enrollment, reason: string) => void;
}) {
  const [ending, setEnding] = useState<Enrollment | null>(null);
  const nameOf = namesOf(persons);
  const ordered = [...enrollments].sort(byName((enrollment) => nameOf(enrollment.studentPersonId)));
  const open = ordered.filter((enrollment) => enrollment.endedAt === null);
  const ended = ordered.filter((enrollment) => enrollment.endedAt !== null);

  // Only a Person the School holds as a Student, now or from a later start, is
  // enrolled, and only one not already enrolled: enrolling confers no role.
  const students = holdingNowOrLater(memberships, "student", new Date());
  const enrolled = new Set(open.map((enrollment) => enrollment.studentPersonId));
  const enrollable = persons
    .filter((person) => students.has(person.id) && !enrolled.has(person.id))
    .sort(byName((person) => person.displayName));

  const enroll = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const studentPersonId = String(new FormData(form).get("studentPersonId") ?? "");
    if (studentPersonId === "") {
      return;
    }
    if ((await onEnroll(studentPersonId)).ok) {
      form.reset();
    }
  };

  const legend = (
    <>
      <h2>Key</h2>
      <p>Every Student’s participation in this School, open and ended.</p>
      <dl>
        <Key term="Enrollment">
          One Student’s bounded participation in the School. A Student who leaves and returns holds one for each stay.
        </Key>
        <Key term="Open">Recorded, and not yet ended.</Key>
        <Key term="End">
          Departure. It also ends the Student’s open Roster memberships and every Guardian link to them, and narrows the
          Student’s own access to their published records. Every record stays in place.
        </Key>
      </dl>
    </>
  );

  // Named for the sheet it opens, which the navigation lists as Roles.
  const roles = <Link to={{ name: "memberships", schoolId }}>School memberships</Link>;

  return (
    <Sheet {...SHEET} legend={legend}>
      <h1>Enrollments</h1>
      <RecordList
        label="Open Enrollments"
        rows={open}
        keyOf={(enrollment) => enrollment.id}
        empty="No Student is enrolled in this School. Start the first Enrollment below."
        columns={[
          { head: "Student", cell: (enrollment) => nameOf(enrollment.studentPersonId) },
          { head: "Started", cell: (enrollment) => DAY.format(new Date(enrollment.startedAt)) },
          { head: "State", cell: () => <span className="mark mark--open">Open</span> },
          {
            head: "End",
            actions: true,
            cell: (enrollment) => (
              <button
                type="button"
                className="button-stamp"
                disabled={busy}
                aria-label={`End ${nameOf(enrollment.studentPersonId)}’s Enrollment`}
                onClick={() => setEnding(enrollment)}
              >
                End
              </button>
            ),
          },
        ]}
      />

      <form onSubmit={enroll} aria-label="Start an Enrollment">
        <h2>Start an Enrollment</h2>
        {enrollable.length === 0 ? (
          <p className="empty">
            No Person holding a Student membership is waiting to be enrolled. To enroll someone, first grant them a
            Student membership on {roles}.
          </p>
        ) : (
          <>
            <label>
              Student
              <select name="studentPersonId" required defaultValue="">
                <option value="" disabled>
                  Choose a Student
                </option>
                {enrollable.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.displayName}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">
              Only a Person holding a Student membership is listed. Enrolling grants no role; that is done on {roles}.
            </p>
            <button type="submit" disabled={busy}>
              Start Enrollment
            </button>
          </>
        )}
      </form>

      <section>
        <h2>Ended</h2>
        <RecordList
          label="Ended Enrollments"
          rows={ended}
          keyOf={(enrollment) => enrollment.id}
          empty="No Enrollment in this School has ended."
          columns={[
            { head: "Student", cell: (enrollment) => nameOf(enrollment.studentPersonId) },
            { head: "Started", cell: (enrollment) => DAY.format(new Date(enrollment.startedAt)) },
            { head: "Ended", cell: (enrollment) => DAY.format(new Date(enrollment.endedAt!)) },
            { head: "Reason", cell: (enrollment) => enrollment.endReason },
          ]}
        />
      </section>

      {ending !== null && (
        <EndEnrollment
          student={nameOf(ending.studentPersonId)}
          guardians={guardiansOf(ending, guardianLinks).map((link) => nameOf(link.guardianPersonId))}
          busy={busy}
          onCancel={() => setEnding(null)}
          onEnd={(reason) => {
            setEnding(null);
            onEnd(ending, reason);
          }}
        />
      )}
    </Sheet>
  );
}

/** The Guardian links in force to this Enrollment's Student: the ones ending it ends too. */
function guardiansOf(enrollment: Enrollment, links: GuardianLink[]): GuardianLink[] {
  return links.filter((link) => link.studentPersonId === enrollment.studentPersonId && link.endedAt === null);
}

/**
 * The confirmation for the app's most consequential action, naming the cascade
 * in the glossary's terms and with the counts, and asking why: an Enrollment
 * does not end without a reason, which goes on its Audit record.
 */
function EndEnrollment({
  student,
  guardians,
  busy,
  onCancel,
  onEnd,
}: {
  student: string;
  guardians: string[];
  busy: boolean;
  onCancel: () => void;
  onEnd: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const links = guardians.length === 1 ? "1 Guardian link" : `${guardians.length} Guardian links`;
  return (
    <ConfirmDialog
      title={`End ${student}’s Enrollment?`}
      confirm="End the Enrollment"
      busy={busy || reason.trim() === ""}
      onCancel={onCancel}
      onConfirm={() => onEnd(reason)}
    >
      <p>{student} departs the School. Ending this Enrollment also ends:</p>
      <ul className="consequences">
        <li>
          <strong>0 open Roster memberships.</strong> Rostering is not built yet, so {student} holds none.
        </li>
        <li>
          <strong>{links}.</strong>{" "}
          {guardians.length === 0
            ? `No Guardian is linked to ${student}.`
            : `${guardians.join(", ")} ${guardians.length === 1 ? "loses" : "each lose"} access to ${student}.`}
        </li>
      </ul>
      <p>
        {student}’s own access narrows to their published records. Every record stays in place with the School: nothing
        is deleted, and nothing is sent anywhere.
      </p>
      <label>
        Reason
        <input
          name="reason"
          required
          maxLength={MAX_REASON_LENGTH}
          autoComplete="off"
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value)}
        />
      </label>
    </ConfirmDialog>
  );
}
