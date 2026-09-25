import { api, type ReachedSchool, type RosteredClassOffering, type RosteredTerm } from "./api.ts";
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
 * The Class Offerings a Student is or was on the roster of, Term by Term: the
 * Term running today first, then the rest, the latest first. Each names who
 * teaches it and the days the Student is on its roster, and opens on its own
 * page. Nothing about any classmate appears.
 *
 * A Student whose Enrollment has ended keeps this page: the classes they took
 * part in stay theirs to read (CONTEXT.md: Enrollment). It reads, and never
 * writes: rostering is a School Administrator's.
 */
export function StudentClasses({ school }: { school: ReachedSchool }) {
  const { showing } = useScreen(school.schoolId, api.ownRosterMemberships);

  switch (showing.kind) {
    case "loading":
      return <Sheet {...SHEET} busy />;
    case "not-available":
      return <NotAvailable />;
    case "ready":
      return <ClassesSheet schoolId={school.schoolId} terms={showing.records.terms} />;
  }
}

function ClassesSheet({ schoolId, terms }: { schoolId: string; terms: RosteredTerm[] }) {
  const legend = (
    <>
      <h2>Key</h2>
      <p>The Class Offerings you are on the roster of, and nothing about anyone else&rsquo;s.</p>
      <dl>
        <Key term="Current">The Term running today, listed first.</Key>
        <Key term="Taught by">The Faculty assigned to teach it.</Key>
        <Key term="On the roster">The days you are in the class, inside its Term.</Key>
      </dl>
    </>
  );

  if (terms.length === 0) {
    return (
      <Sheet {...SHEET} legend={legend}>
        <h1>Your classes</h1>
        <p className="empty">
          You have no classes yet. Once a School Administrator puts you on a Class Offering&rsquo;s roster, it is listed
          here.
        </p>
      </Sheet>
    );
  }

  return (
    <Sheet {...SHEET} legend={legend}>
      <h1>Your classes</h1>
      {terms.map(({ term, current, classOfferings }) => {
        const name = `${term.name}, ${term.academicYear.name}`;
        return (
          <section key={term.id}>
            <h2>
              {name} {current && <span className="mark mark--open">Current</span>}
            </h2>
            <p className="muted">
              {schoolDay(term.firstDate)} to {schoolDay(term.lastDate)}
            </p>
            <RecordList
              label={`Your classes in ${name}`}
              rows={classOfferings}
              keyOf={(offering) => offering.id}
              empty="You have no class this Term."
              columns={[
                {
                  head: "Class",
                  cell: (offering) => (
                    <Link to={{ name: "classOffering", schoolId, classOfferingId: offering.id }}>
                      {offeringName(offering)}
                    </Link>
                  ),
                },
                { head: "Taught by", cell: taughtBy },
                { head: "On the roster", cell: onRoster },
              ]}
            />
          </section>
        );
      })}
    </Sheet>
  );
}

/** Everyone ever assigned to teach it, each once. */
function taughtBy(offering: RosteredClassOffering) {
  const names = [...new Set(offering.teachingAssignments.map((assignment) => assignment.person.displayName))];
  return names.length === 0 ? <span className="muted">No one yet</span> : names.join(", ");
}

/** The days the Student is on its roster: the whole Term, or each span of School dates when it is less. */
function onRoster(offering: RosteredClassOffering): string {
  const { term } = offering;
  const spans = offering.rosterMemberships.map(({ firstDate, lastDate }) => ({
    firstDate,
    lastDate: lastDate ?? term.lastDate,
  }));
  if (spans.length === 1 && spans[0]!.firstDate === term.firstDate && spans[0]!.lastDate === term.lastDate) {
    return "The whole Term";
  }
  return spans.map((span) => `${schoolDay(span.firstDate)} to ${schoolDay(span.lastDate)}`).join("; ");
}
