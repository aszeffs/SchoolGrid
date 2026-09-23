import { api, type OwnAccount, type ReachedSchool, type Role } from "./api.ts";
import { NotAvailable } from "./NotAvailable.tsx";
import { RecordList } from "./RecordList.tsx";
import { ROLE_NAMES } from "./roles.ts";
import { useScreen } from "./screen.ts";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";

/** Which sheet this page is, named once so its states cannot drift apart. */
const SHEET: SheetKind = { stock: "salmon", name: "Your account" };

const DAY = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/**
 * What one Person holds in one School: who they are here, the memberships they
 * hold, the Enrollment they hold as a Student, and the Students they reach as
 * a Guardian.
 *
 * Every page for a Faculty member, a Student and a Guardian was a list of
 * other Persons until this one; this is where they land instead. It reads,
 * and never writes: a membership, an Enrollment and a Guardian link are all a
 * School Administrator's to change, and this page offers no way to.
 */
export function Account({ school }: { school: ReachedSchool }) {
  const { showing } = useScreen(school.schoolId, api.account);

  switch (showing.kind) {
    case "loading":
      return <Sheet {...SHEET} busy />;
    case "not-available":
      return <NotAvailable />;
    case "ready":
      return <AccountSheet account={showing.records.account} school={school} />;
  }
}

/**
 * Who the actor is here and what they hold. The Person, the School and the
 * roles are the session's, already read by the shell; the Enrollment and the
 * links are what only this page asks for.
 */
function AccountSheet({ account, school }: { account: OwnAccount; school: ReachedSchool }) {
  const holds = (role: Role) => school.roles.includes(role);
  const legend = (
    <>
      <h2>This sheet</h2>
      <p>What this School holds for you, and nothing about anyone else.</p>
      <dl>
        <Key term="School membership">
          One role you hold in this School, with its own start and end. Holding several is ordinary.
        </Key>
        {holds("student") && (
          <Key term="Enrollment">
            Your participation in this School. Marked Open from the day it was recorded until the day it ends.
          </Key>
        )}
        {holds("guardian") && (
          <Key term="Access profile">
            What your link to one Student lets you read of theirs, set for that link alone. May read is struck; May
            not read is not.
          </Key>
        )}
      </dl>
    </>
  );

  return (
    <Sheet {...SHEET} legend={legend}>
      <h1>Your account</h1>
      <dl className="facts">
        <dt>Person</dt>
        <dd>{school.displayName}</dd>
        <dt>School</dt>
        <dd>{school.name}</dd>
        <dt>School memberships</dt>
        <dd>{school.roles.map((role) => ROLE_NAMES[role]).join(", ")}</dd>
      </dl>

      {holds("student") && <Enrollment enrollment={account.enrollment} />}
      {holds("guardian") && <LinkedStudents account={account} />}

      <section className="not-built">
        <h2>Not built yet</h2>
        <p>
          Attendance and Term results are not built yet, so there is nothing of either to show you here. What this
          School holds for you today is above, in full.
        </p>
      </section>
    </Sheet>
  );
}

/** The Student's own Enrollment as it stands, or that they hold none. */
function Enrollment({ enrollment }: { enrollment: OwnAccount["enrollment"] }) {
  return (
    <section>
      <h2>Your Enrollment</h2>
      {enrollment === null ? (
        <p className="empty">You hold no Enrollment in this School.</p>
      ) : (
        <dl className="facts">
          <dt>Started</dt>
          <dd>{DAY.format(new Date(enrollment.startedAt))}</dd>
          <dt>Ended</dt>
          <dd>
            {enrollment.endedAt === null ? (
              <span className="mark mark--open">Open</span>
            ) : (
              DAY.format(new Date(enrollment.endedAt))
            )}
          </dd>
        </dl>
      )}
    </section>
  );
}

/**
 * Each Student this Guardian is linked to, and what that link's Access profile
 * permits. Shown as it stands and not offered for changing: a profile is a
 * School Administrator's to set.
 */
function LinkedStudents({ account }: { account: OwnAccount }) {
  return (
    <section>
      <h2>Students you are linked to</h2>
      <RecordList
        label="Students you are linked to"
        rows={account.linkedStudents}
        keyOf={(linked) => linked.student.id}
        empty="You are linked to no Student in this School."
        columns={[
          { head: "Student", cell: (linked) => linked.student.displayName },
          { head: "Attendance", cell: (linked) => <Permits permitted={linked.accessProfile.attendanceRead} /> },
          { head: "Term results", cell: (linked) => <Permits permitted={linked.accessProfile.resultsRead} /> },
        ]}
      />
      <p className="muted">
        Your School Administrator sets what each link lets you read. Ask them to change it.
      </p>
    </section>
  );
}

/**
 * One permission of an Access profile: whether this link lets you read that
 * record. What the link permits is struck solid, as a settled fact is; what it
 * does not is left unstruck. The open mark is not used here: dashed means not
 * yet done, and a permission withheld is decided, not pending.
 */
function Permits({ permitted }: { permitted: boolean }) {
  return (
    <span className={permitted ? "mark mark--struck" : "mark"}>{permitted ? "May read" : "May not read"}</span>
  );
}
