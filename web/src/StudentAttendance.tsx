import type { StudentAttendance } from "./api.ts";
import { STATUS_NAMES, TALLIES, TALLY_NAMES } from "./attendance.ts";
import { CourseName } from "./CourseChart.tsx";
import { Link } from "./Link.tsx";
import { offeringName } from "./offerings.ts";
import { RecordList } from "./RecordList.tsx";
import { Key } from "./Sheet.tsx";
import { formatSchoolDate } from "./standing.ts";

type Offering = StudentAttendance["classOfferings"][number];

/** What one Student's Attendance marks mean, for the key of the page showing it. */
export function StudentAttendanceKeys() {
  return (
    <dl>
      <Key term="Not recorded">An Instructional day so far, on the roster, with no Attendance recorded.</Key>
      <Key term="Not counted">
        Recorded on a day that has since stopped being an Instructional day. It stays, and leaves the totals.
      </Key>
    </dl>
  );
}

/**
 * One Student's own Attendance, Term by Term, the latest first: their totals
 * in each Class Offering, and under them every day marked, opened on request
 * so a Term of days does not bury the totals. Nothing about any classmate
 * appears, nor who recorded a mark.
 *
 * Each Term is headed at `level`, so the record reads the same on the
 * Student's own page and under a linked Student's name on a Guardian's.
 * `opensOfferings` links each Class Offering to its own page, which only a
 * Student rostered in it may open.
 */
export function StudentAttendanceRecord({
  schoolId,
  attendance,
  level,
  opensOfferings,
  empty,
}: {
  schoolId: string;
  attendance: StudentAttendance;
  level: "h2" | "h3" | "h4";
  opensOfferings: boolean;
  empty: string;
}) {
  const Heading = level;
  const terms = new Map<string, Offering[]>();
  for (const offering of attendance.classOfferings) {
    terms.set(offering.term.id, [...(terms.get(offering.term.id) ?? []), offering]);
  }
  if (terms.size === 0) {
    return <p className="empty">{empty}</p>;
  }
  const named = (offering: Offering) =>
    opensOfferings ? (
      <CourseName course={offering.course}>
        <Link to={{ name: "classOffering", schoolId, classOfferingId: offering.id }}>{offeringName(offering)}</Link>
      </CourseName>
    ) : (
      <CourseName course={offering.course}>{offeringName(offering)}</CourseName>
    );

  return [...terms.values()].map((offerings) => {
    const { term } = offerings[0]!;
    const name = `${term.name}, ${term.academicYear.name}`;
    const marks = offerings
      .flatMap((offering) => offering.attendance.map((mark) => ({ offering, ...mark })))
      .sort((a, b) => b.date.localeCompare(a.date) || offeringName(a.offering).localeCompare(offeringName(b.offering)));
    return (
      <section key={term.id}>
        <Heading>{name}</Heading>
        <p className="muted">
          Totals from {formatSchoolDate(term.firstDate)} to{" "}
          {formatSchoolDate(attendance.today < term.lastDate ? attendance.today : term.lastDate)}.
        </p>
        <RecordList
          label={`${attendance.student.displayName}'s Attendance totals in ${name}`}
          rows={offerings}
          keyOf={(offering) => offering.id}
          empty=""
          columns={[
            { head: "Class Offering", cell: named },
            ...TALLIES.map((tally) => ({ head: TALLY_NAMES[tally], cell: (offering: Offering) => offering.totals[tally] })),
          ]}
        />
        <details className="disclosure">
          <summary>Each day marked in {name}</summary>
          <RecordList
            label={`${attendance.student.displayName}'s Attendance by date in ${name}`}
            rows={marks}
            keyOf={(mark) => `${mark.offering.id}:${mark.date}`}
            empty="No Attendance has been recorded this Term yet."
            columns={[
              { head: "Date", cell: (mark) => formatSchoolDate(mark.date) },
              { head: "Class Offering", cell: (mark) => offeringName(mark.offering) },
              {
                head: "Attendance",
                cell: (mark) => (
                  <>
                    {STATUS_NAMES[mark.status]}
                    {!mark.counted && (
                      <>
                        {" "}
                        <span className="mark mark--struck">Not counted</span>
                      </>
                    )}
                  </>
                ),
              },
            ]}
          />
        </details>
      </section>
    );
  });
}
