import { api, type ReachedSchool, type TaughtClassOffering } from "./api.ts";
import { Link } from "./Link.tsx";
import { NotAvailable } from "./NotAvailable.tsx";
import { offeringName } from "./offerings.ts";
import { RecordList } from "./RecordList.tsx";
import { useScreen } from "./screen.ts";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";
import { schoolDay } from "./standing.ts";

/** Which sheet this page is, named once so its states cannot drift apart. */
const SHEET: SheetKind = { name: "Your classes" };

/**
 * The Class Offerings a Faculty member teaches, and those they taught: the
 * ones an assignment of theirs still runs in first, then those over. Each
 * opens on its own page, with everyone who teaches it.
 *
 * It reads, and never writes: a Teaching assignment is a School
 * Administrator's to make, change and end.
 */
export function YourClasses({ school }: { school: ReachedSchool }) {
  const { showing } = useScreen(school.schoolId, api.ownClassOfferings);

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
  current,
  past,
}: {
  schoolId: string;
  personId: string;
  current: TaughtClassOffering[];
  past: TaughtClassOffering[];
}) {
  const legend = (
    <>
      <h2>Key</h2>
      <p>The Class Offerings you are assigned to teach, and nothing about anyone else&rsquo;s.</p>
      <dl>
        <Key term="Current">Taught by you now, or from a day still to come.</Key>
        <Key term="Past">Every assignment of yours to it has ended. You can still open it.</Key>
        <Key term="Teaching">The days you teach it, inside its Term.</Key>
      </dl>
    </>
  );

  if (current.length === 0 && past.length === 0) {
    return (
      <Sheet {...SHEET} legend={legend}>
        <h1>Your classes</h1>
        <p className="empty">
          You teach no Class Offering yet. Once a School Administrator assigns you to teach one, it is listed
          here.
        </p>
      </Sheet>
    );
  }

  return (
    <Sheet {...SHEET} legend={legend}>
      <h1>Your classes</h1>
      <section>
        <h2>Current</h2>
        <Classes
          label="Your current Class Offerings"
          schoolId={schoolId}
          personId={personId}
          rows={current}
          empty="You teach no Class Offering now, and none is still to come."
        />
      </section>
      <section>
        <h2>Past</h2>
        <Classes
          label="Your past Class Offerings"
          schoolId={schoolId}
          personId={personId}
          rows={past}
          empty="You have taught no Class Offering that has ended."
        />
      </section>
    </Sheet>
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
            <Link to={{ name: "classOffering", schoolId, classOfferingId: offering.id }}>{offeringName(offering)}</Link>
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
        `${schoolDay(assignment.firstDate)} to ${schoolDay(assignment.lastDate ?? offering.term.lastDate)}`,
    )
    .join("; ");
}
