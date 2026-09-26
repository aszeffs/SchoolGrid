import type { RosteredClassOffering, RosteredTerm } from "./api.ts";
import { CourseName } from "./CourseChart.tsx";
import { Link } from "./Link.tsx";
import { offeringName } from "./offerings.ts";
import { RecordList } from "./RecordList.tsx";
import { Key } from "./Sheet.tsx";
import { formatSchoolDate } from "./standing.ts";

/** What a Student's own marks mean, for the key of the page listing them. */
export function RosteredKeys() {
  return (
    <dl>
      <Key term="Current">The Term running today, listed first.</Key>
      <Key term="Taught by">The Faculty assigned to teach it.</Key>
      <Key term="On the roster">The days you are on its roster, inside its Term.</Key>
    </dl>
  );
}

/**
 * The Class Offerings a Student is or was on the roster of, Term by Term: the
 * Term running today first, then the rest, the latest first. Each names who
 * teaches it and the days the Student is on its roster, and opens on its own
 * page. Nothing about any classmate appears.
 *
 * A Student whose Enrollment has ended keeps these: the Class Offerings they
 * took part in stay theirs to read (CONTEXT.md: Enrollment). Each Term is
 * headed at `level`, so the list reads the same on its own or under a heading
 * of its own beside the Class Offerings the Person teaches.
 */
export function RosteredClasses({
  schoolId,
  terms,
  level,
}: {
  schoolId: string;
  terms: RosteredTerm[];
  level: "h2" | "h3";
}) {
  const Heading = level;
  if (terms.length === 0) {
    return (
      <p className="empty">
        You are on no Class Offering&rsquo;s roster yet. Once a School Administrator puts you on one, it is listed
        here.
      </p>
    );
  }
  return terms.map(({ term, current, classOfferings }) => {
    const name = `${term.name}, ${term.academicYear.name}`;
    return (
      <section key={term.id}>
        <Heading>
          {name} {current && <span className="mark mark--open">Current</span>}
        </Heading>
        <p className="muted">
          {formatSchoolDate(term.firstDate)} to {formatSchoolDate(term.lastDate)}
        </p>
        <RecordList
          label={`Your Class Offerings in ${name}`}
          rows={classOfferings}
          keyOf={(offering) => offering.id}
          empty="You are on no Class Offering’s roster this Term."
          columns={[
            {
              head: "Class Offering",
              cell: (offering) => (
                <CourseName course={offering.course}>
                  <Link to={{ name: "classOffering", schoolId, classOfferingId: offering.id }}>
                    {offeringName(offering)}
                  </Link>
                </CourseName>
              ),
            },
            { head: "Taught by", cell: taughtBy },
            { head: "On the roster", cell: onRoster },
          ]}
        />
      </section>
    );
  });
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
  return spans.map((span) => `${formatSchoolDate(span.firstDate)} to ${formatSchoolDate(span.lastDate)}`).join("; ");
}
