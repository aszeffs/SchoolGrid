import { api, type ApiResult, type ReachedSchool, type RosteredTerm, type TaughtClassOffering } from "./api.ts";
import { CourseName } from "./CourseChart.tsx";
import { Link } from "./Link.tsx";
import { NotAvailable } from "./NotAvailable.tsx";
import { offeringName } from "./offerings.ts";
import { RecordList } from "./RecordList.tsx";
import { teaches } from "./roles.ts";
import { useScreen } from "./screen.ts";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";
import { formatSchoolDate } from "./standing.ts";
import { RosteredClasses, RosteredKeys } from "./RosteredClasses.tsx";

/** Which sheet this page is, named once so its states cannot drift apart. */
const SHEET: SheetKind = { name: "Your classes" };

interface Taught {
  current: TaughtClassOffering[];
  past: TaughtClassOffering[];
}

/** What the page lists: the Class Offerings the Person teaches, those they are on the roster of, or both. */
interface OwnClasses {
  taught?: Taught;
  rostered?: RosteredTerm[];
}

/** Reads each list asked for, and is the one refusal if either is refused. */
async function read(schoolId: string, taught: boolean, rostered: boolean): Promise<ApiResult<OwnClasses>> {
  const [teaching, roster] = await Promise.all([
    taught ? api.ownClassOfferings(schoolId) : undefined,
    rostered ? api.ownRosterMemberships(schoolId) : undefined,
  ]);
  if (teaching?.ok === false || roster?.ok === false) {
    return { ok: false };
  }
  return {
    ok: true,
    body: {
      ...(teaching === undefined ? {} : { taught: teaching.body }),
      ...(roster === undefined ? {} : { rostered: roster.body.terms }),
    },
  };
}

// Defined once each, so the screen is not read again on every render.
const LISTS = {
  taught: (schoolId: string) => read(schoolId, true, false),
  rostered: (schoolId: string) => read(schoolId, false, true),
  both: (schoolId: string) => read(schoolId, true, true),
};

/**
 * The Class Offerings a Person teaches and taught, and those they are and were
 * on the roster of: whichever they have, and both for a Faculty member who is
 * also a Student. Each opens on its own page.
 *
 * Anyone ever assigned to teach keeps their list once their Faculty membership
 * has ended (CONTEXT.md: Teaching assignment), and a Student theirs once their
 * Enrollment has (CONTEXT.md: Enrollment). A Person who is neither is asked
 * about the Class Offerings they teach, and the server refuses it.
 *
 * It reads, and never writes: Teaching assignments and rosters are a School
 * Administrator's to make, change and end.
 */
export function YourClasses({ school }: { school: ReachedSchool }) {
  const rostered = school.roles.includes("student");
  const taught = teaches(school) || !rostered;
  const { showing } = useScreen(school.schoolId, LISTS[taught && rostered ? "both" : taught ? "taught" : "rostered"]);

  switch (showing.kind) {
    case "loading":
      return <Sheet {...SHEET} busy />;
    case "not-available":
      return <NotAvailable />;
    case "ready":
      return <ClassesSheet schoolId={school.schoolId} personId={school.personId} {...showing.records} />;
  }
}

function ClassesSheet({
  schoolId,
  personId,
  taught,
  rostered,
}: {
  schoolId: string;
  personId: string;
} & OwnClasses) {
  if (taught !== undefined && rostered !== undefined) {
    const legend = (
      <>
        <h2>Key</h2>
        <p>The Class Offerings you teach and those you are on the roster of, and nothing about anyone else&rsquo;s.</p>
        <h3>Class Offerings you teach</h3>
        <TaughtKeys />
        <h3>Class Offerings you are on the roster of</h3>
        <RosteredKeys />
      </>
    );
    return (
      <Sheet {...SHEET} legend={legend}>
        <h1>Your classes</h1>
        <section>
          <h2>Class Offerings you teach</h2>
          <TaughtClasses schoolId={schoolId} personId={personId} {...taught} level="h3" />
        </section>
        <section>
          <h2>Class Offerings you are on the roster of</h2>
          <RosteredClasses schoolId={schoolId} terms={rostered} level="h3" />
        </section>
      </Sheet>
    );
  }

  if (rostered !== undefined) {
    const legend = (
      <>
        <h2>Key</h2>
        <p>The Class Offerings you are on the roster of, and nothing about anyone else&rsquo;s.</p>
        <RosteredKeys />
      </>
    );
    return (
      <Sheet {...SHEET} legend={legend}>
        <h1>Your classes</h1>
        <RosteredClasses schoolId={schoolId} terms={rostered} level="h2" />
      </Sheet>
    );
  }

  const legend = (
    <>
      <h2>Key</h2>
      <p>The Class Offerings you are assigned to teach, and nothing about anyone else&rsquo;s.</p>
      <TaughtKeys />
    </>
  );
  return (
    <Sheet {...SHEET} legend={legend}>
      <h1>Your classes</h1>
      <TaughtClasses schoolId={schoolId} personId={personId} {...taught!} level="h2" />
    </Sheet>
  );
}

function TaughtKeys() {
  return (
    <dl>
      <Key term="Current">Taught by you now, or from a day still to come.</Key>
      <Key term="Past">Every assignment of yours to it has ended. You can still open it.</Key>
      <Key term="Teaching">The days you teach it, inside its Term.</Key>
    </dl>
  );
}

/**
 * The Class Offerings a Person teaches, and those they taught: the ones an
 * assignment of theirs still runs in first, then those over. Each is listed
 * with everyone else who teaches it. Headed at `level`, as the Student's list
 * beside it is.
 */
function TaughtClasses({
  schoolId,
  personId,
  current,
  past,
  level,
}: {
  schoolId: string;
  personId: string;
  level: "h2" | "h3";
} & Taught) {
  const Heading = level;
  if (current.length === 0 && past.length === 0) {
    return (
      <p className="empty">
        You teach no Class Offering yet. Once a School Administrator assigns you to teach one, it is listed here.
      </p>
    );
  }
  return (
    <>
      <section>
        <Heading>Current</Heading>
        <Classes
          label="Your current Class Offerings"
          schoolId={schoolId}
          personId={personId}
          rows={current}
          empty="You teach no Class Offering now, and none is still to come."
        />
      </section>
      <section>
        <Heading>Past</Heading>
        <Classes
          label="Your past Class Offerings"
          schoolId={schoolId}
          personId={personId}
          rows={past}
          empty="You have taught no Class Offering that has ended."
        />
      </section>
    </>
  );
}

function Classes({
  label,
  schoolId,
  personId,
  rows,
  empty,
}: {
  label: string;
  schoolId: string;
  personId: string;
  rows: TaughtClassOffering[];
  empty: string;
}) {
  return (
    <RecordList
      label={label}
      rows={rows}
      keyOf={(offering) => offering.id}
      empty={empty}
      columns={[
        {
          head: "Class Offering",
          cell: (offering) => (
            <CourseName course={offering.course}>
              <Link to={{ name: "classOffering", schoolId, classOfferingId: offering.id }}>{offeringName(offering)}</Link>
            </CourseName>
          ),
        },
        { head: "Term", cell: (offering) => `${offering.term.name}, ${offering.term.academicYear.name}` },
        { head: "Teaching", cell: (offering) => teaching(offering, personId) },
        {
          head: "With",
          cell: (offering) => {
            const others = [
              ...new Set(
                offering.teachingAssignments
                  .filter((assignment) => assignment.person.id !== personId)
                  .map((assignment) => assignment.person.displayName),
              ),
            ];
            return others.length === 0 ? <span className="muted">No one else</span> : others.join(", ");
          },
        },
      ]}
    />
  );
}

/** The days this Person teaches the offering, each assignment of theirs as a span of School dates. */
function teaching(offering: TaughtClassOffering, personId: string): string {
  return offering.teachingAssignments
    .filter((assignment) => assignment.person.id === personId)
    .map(
      (assignment) =>
        `${formatSchoolDate(assignment.firstDate)} to ${formatSchoolDate(assignment.lastDate ?? offering.term.lastDate)}`,
    )
    .join("; ");
}
