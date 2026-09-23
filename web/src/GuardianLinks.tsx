import { useState, type FormEvent } from "react";
import { api, readAll, type AccessProfile, type GuardianLink, type ReachedSchool } from "./api.ts";
import { ConfirmDialog } from "./Dialog.tsx";
import { Link } from "./Link.tsx";
import { NotAvailable } from "./NotAvailable.tsx";
import { RecordList } from "./RecordList.tsx";
import { useScreen } from "./screen.ts";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";
import { byName, DAY, holdingNowOrLater, namesOf } from "./standing.ts";

/**
 * Which sheet this page is, named once so its states cannot drift apart.
 *
 * Run on Your account's stock (web/DESIGN.md): a Guardian link and its Access
 * profile are set here and read there, the same business seen from its two
 * ends, as the Invitation's two sheets are.
 */
const SHEET: SheetKind = { stock: "salmon", name: "Guardian links" };

/**
 * A School's Guardian links, with what making one needs: the Persons to name
 * them by, the memberships that say who is a Guardian and who a Student, and
 * the Enrollments that say which Students may be linked.
 */
async function list(schoolId: string) {
  const answered = await readAll([
    api.guardianLinks(schoolId),
    api.persons(schoolId),
    api.memberships(schoolId),
    api.enrollments(schoolId),
  ]);
  if (!answered.ok) {
    return answered;
  }
  const [{ guardianLinks }, { persons }, { memberships }, { enrollments }] = answered.body;
  return { ok: true as const, body: { guardianLinks, persons, memberships, enrollments } };
}

type Records = Extract<Awaited<ReturnType<typeof list>>, { ok: true }>["body"];

/** The Access profile's two permissions, each independent of the other, as the glossary names them. */
const PERMISSIONS: { key: keyof AccessProfile; name: string }[] = [
  { key: "attendanceRead", name: "Attendance read" },
  { key: "resultsRead", name: "Results read" },
];

/**
 * Every Guardian link in the School, the way to make one and end one, and each
 * link's Access profile.
 *
 * Both permissions govern records that do not exist yet: there is no
 * Attendance and no Term result to read until academic records ship. They are
 * real all the same — set here, held on the link, shown to the Guardian — and
 * the sheet says plainly that they take effect later, so an inert permission
 * is not mistaken for a broken one.
 */
export function GuardianLinks({ school }: { school: ReachedSchool }) {
  const { schoolId } = school;
  const { showing, busy, change } = useScreen(schoolId, list);

  switch (showing.kind) {
    case "loading":
      return <Sheet {...SHEET} busy />;
    case "not-available":
      return <NotAvailable />;
    case "ready":
      return (
        <GuardianLinksSheet
          records={showing.records}
          schoolId={schoolId}
          busy={busy}
          onLink={(link) => change(() => api.linkGuardian(schoolId, link))}
          onPermit={(link, permission) => change(() => api.setAccessProfile(schoolId, link.id, permission))}
          onEnd={(link) => change(() => api.endGuardianLink(schoolId, link.id))}
        />
      );
  }
}

function GuardianLinksSheet({
  records: { guardianLinks, persons, memberships, enrollments },
  schoolId,
  busy,
  onLink,
  onPermit,
  onEnd,
}: {
  records: Records;
  schoolId: string;
  busy: boolean;
  onLink: (link: { guardianPersonId: string; studentPersonId: string; accessProfile: AccessProfile }) => Promise<{
    ok: boolean;
  }>;
  onPermit: (link: GuardianLink, permission: Partial<AccessProfile>) => void;
  onEnd: (link: GuardianLink) => void;
}) {
  const [ending, setEnding] = useState<GuardianLink | null>(null);
  const nameOf = namesOf(persons);
  const ordered = [...guardianLinks].sort(
    byName((link) => `${nameOf(link.studentPersonId)} ${nameOf(link.guardianPersonId)}`),
  );
  const inForce = ordered.filter((link) => link.endedAt === null);
  const ended = ordered.filter((link) => link.endedAt !== null);
  /** Names a link by both its ends, so a control says which of a Guardian's links it acts on. */
  const between = (link: GuardianLink) => `${nameOf(link.guardianPersonId)}’s link to ${nameOf(link.studentPersonId)}`;

  // A link is only between a Person the School holds as a Guardian and one it
  // holds as an enrolled Student. Linking grants neither role.
  const now = new Date();
  const guardianIds = holdingNowOrLater(memberships, "guardian", now);
  const studentIds = holdingNowOrLater(memberships, "student", now);
  const enrolled = new Set(
    enrollments.filter((enrollment) => enrollment.endedAt === null).map((enrollment) => enrollment.studentPersonId),
  );
  const byDisplayName = byName((person: { displayName: string }) => person.displayName);
  const guardians = persons.filter((person) => guardianIds.has(person.id)).sort(byDisplayName);
  const students = persons.filter((person) => studentIds.has(person.id) && enrolled.has(person.id)).sort(byDisplayName);

  const link = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const guardianPersonId = String(fields.get("guardianPersonId") ?? "");
    const studentPersonId = String(fields.get("studentPersonId") ?? "");
    if (guardianPersonId === "" || studentPersonId === "") {
      return;
    }
    // Both permissions are stated, checked or not: a profile is never left to a default.
    const accessProfile = {
      attendanceRead: fields.get("attendanceRead") !== null,
      resultsRead: fields.get("resultsRead") !== null,
    };
    if ((await onLink({ guardianPersonId, studentPersonId, accessProfile })).ok) {
      form.reset();
    }
  };

  const legend = (
    <>
      <h2>This sheet</h2>
      <p>Every Guardian link in this School, and what each one’s Access profile permits.</p>
      <dl>
        <Key term="Guardian link">
          One Guardian’s link to one Student. It ends by itself when the Student’s Enrollment ends.
        </Key>
        <Key term="Access profile">
          What one link lets its Guardian read of the Student’s: attendance, results, both or neither. Each is set
          alone.
        </Key>
        <Key term="End">
          The Guardian stops reaching the Student. The link stays on this sheet as ended; to restore it, make a new
          one.
        </Key>
      </dl>
    </>
  );

  // Named for the sheets they open, which the navigation lists as Roles and Enrollments.
  const roles = <Link to={{ name: "memberships", schoolId }}>School memberships</Link>;
  const enrollmentsLink = <Link to={{ name: "enrollments", schoolId }}>Enrollments</Link>;

  return (
    <Sheet {...SHEET} legend={legend}>
      <h1>Guardian links</h1>
      <p className="notice">
        Attendance read and results read take effect once academic records ship. Until then there is no Attendance
        and no Term result to read, so each permission is recorded on its link and shown to its Guardian, and governs
        nothing yet.
      </p>
      <RecordList
        label="Guardian links in force"
        rows={inForce}
        keyOf={(link) => link.id}
        empty="No Guardian is linked to a Student in this School. Make the first link below."
        columns={[
          { head: "Student", cell: (link) => nameOf(link.studentPersonId) },
          { head: "Guardian", cell: (link) => nameOf(link.guardianPersonId) },
          ...PERMISSIONS.map(({ key, name }) => ({
            head: name,
            cell: (link: GuardianLink) => (
              // Not a <label>: the control is named for the link it acts on,
              // and what it permits is struck beside it as a mark.
              <span className="check">
                <input
                  type="checkbox"
                  // Held to what the server last said. A change is sent and the
                  // record listed again; nothing is ticked before it is confirmed.
                  checked={link.accessProfile[key]}
                  disabled={busy}
                  aria-label={`${name} on ${between(link)}`}
                  onChange={(event) => onPermit(link, { [key]: event.currentTarget.checked })}
                />
                <span className={link.accessProfile[key] ? "mark mark--struck" : "mark"}>
                  {link.accessProfile[key] ? "May read" : "May not read"}
                </span>
              </span>
            ),
          })),
          {
            head: "End",
            actions: true,
            cell: (link) => (
              <button
                type="button"
                className="button-stamp"
                disabled={busy}
                aria-label={`End ${between(link)}`}
                onClick={() => setEnding(link)}
              >
                End
              </button>
            ),
          },
        ]}
      />

      <form onSubmit={link} aria-label="Make a Guardian link">
        <h2>Make a Guardian link</h2>
        {guardians.length === 0 || students.length === 0 ? (
          <p className="empty">
            {guardians.length === 0
              ? "No Person holds a Guardian membership here yet. "
              : "No Student holding a Student membership is enrolled here yet. "}
            A link is made between a Person holding a Guardian membership and an enrolled Student: grant the role on{" "}
            {roles}, and enroll the Student on {enrollmentsLink}.
          </p>
        ) : (
          <>
            <label>
              Guardian
              <select name="guardianPersonId" required defaultValue="">
                <option value="" disabled>
                  Choose a Guardian
                </option>
                {guardians.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Student
              <select name="studentPersonId" required defaultValue="">
                <option value="" disabled>
                  Choose a Student
                </option>
                {students.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.displayName}
                  </option>
                ))}
              </select>
            </label>
            <fieldset>
              <legend>Access profile</legend>
              {PERMISSIONS.map(({ key, name }) => (
                <label key={key} className="check">
                  <input type="checkbox" name={key} />
                  {name}
                </label>
              ))}
            </fieldset>
            <button type="submit" disabled={busy}>
              Link Guardian
            </button>
          </>
        )}
      </form>

      <section>
        <h2>Ended</h2>
        <RecordList
          label="Ended Guardian links"
          rows={ended}
          keyOf={(link) => link.id}
          empty="No Guardian link in this School has ended."
          columns={[
            { head: "Student", cell: (link) => nameOf(link.studentPersonId) },
            { head: "Guardian", cell: (link) => nameOf(link.guardianPersonId) },
            { head: "Made", cell: (link) => DAY.format(new Date(link.createdAt)) },
            { head: "Ended", cell: (link) => DAY.format(new Date(link.endedAt!)) },
          ]}
        />
      </section>

      {ending !== null && (
        <ConfirmDialog
          title="End this Guardian link?"
          confirm="End the link"
          busy={busy}
          onCancel={() => setEnding(null)}
          onConfirm={() => {
            const link = ending;
            setEnding(null);
            onEnd(link);
          }}
        >
          <p>
            {nameOf(ending.guardianPersonId)} stops reaching {nameOf(ending.studentPersonId)}, and whatever this link’s
            Access profile permits ends with it.
          </p>
          <p>
            Any other link {nameOf(ending.guardianPersonId)} holds, and {nameOf(ending.studentPersonId)}’s Enrollment,
            stay as they are. This link stays on the record as ended, and cannot be reopened: to restore it, make a new
            one.
          </p>
        </ConfirmDialog>
      )}
    </Sheet>
  );
}
