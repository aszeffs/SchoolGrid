import { useState, type FormEvent } from "react";
import { MAX_NAME_LENGTH } from "../../src/validation/bounds.ts";
import {
  api,
  readAll,
  type AcademicYear,
  type ApiResult,
  type Course,
  type ListedClassOffering,
  type ReachedSchool,
  type Term,
} from "./api.ts";
import { CourseChart, CourseName } from "./CourseChart.tsx";
import { Link } from "./Link.tsx";
import { NotAvailable } from "./NotAvailable.tsx";
import { courseTitle, labelConflictMessage, offeringName } from "./offerings.ts";
import { RecordList } from "./RecordList.tsx";
import { useScreen } from "./screen.ts";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";
import { dayAfter, formatSchoolDate } from "./standing.ts";

/** Which sheet this page is, named once so its states cannot drift apart. */
const SHEET: SheetKind = { name: "Class Offerings" };

/** The School's Class Offerings, and the Terms and Courses a new one is chosen from. */
async function list(schoolId: string) {
  const answered = await readAll([
    api.classOfferings(schoolId),
    api.academicYears(schoolId),
    api.courses(schoolId),
  ]);
  if (!answered.ok) {
    return answered;
  }
  const [{ classOfferings }, { academicYears }, { courses }] = answered.body;
  return { ok: true as const, body: { classOfferings, academicYears, courses } };
}

/**
 * A School's Class Offerings, one Term at a time: which Courses the Term
 * offers, and the way to offer another. Each offering opens on a page of its
 * own.
 *
 * The session names this page to a School Administrator only (ADR-0007), and
 * the server refuses anyone else with the one "not available" state.
 */
export function ClassOfferings({ school }: { school: ReachedSchool }) {
  const { schoolId } = school;
  const { showing, busy, change } = useScreen(schoolId, list);

  switch (showing.kind) {
    case "loading":
      return <Sheet {...SHEET} busy />;
    case "not-available":
      return <NotAvailable />;
    case "ready":
      return (
        <ClassOfferingsSheet
          schoolId={schoolId}
          {...showing.records}
          busy={busy}
          onOffer={(offering) => change(() => api.offerCourse(schoolId, offering))}
        />
      );
  }
}

function ClassOfferingsSheet({
  schoolId,
  classOfferings,
  academicYears,
  courses,
  busy,
  onOffer,
}: {
  schoolId: string;
  classOfferings: ListedClassOffering[];
  academicYears: AcademicYear[];
  courses: Course[];
  busy: boolean;
  onOffer: (offering: { courseId: string; termId: string; label: string | null }) => Promise<ApiResult<unknown>>;
}) {
  const terms = academicYears.flatMap((year) => year.terms);
  const [chosen, setChosen] = useState<string | null>(null);
  // The Term chosen, while it still exists; otherwise the one the School is in.
  const term = terms.find((each) => each.id === chosen) ?? currentTerm(terms);
  const [problem, setProblem] = useState<string | null>(null);
  /** What the last change did, said once so a screen reader hears it land. */
  const [done, setDone] = useState("");
  /** The Course the reader is pointing at on the wall chart, whose rows stay bright. */
  const [pointed, setPointed] = useState<string | null>(null);

  const legend = (
    <>
      <h2>Key</h2>
      <p>The Courses this School offers, Term by Term.</p>
      <dl>
        <Key term="Class Offering">
          A Course offered for one Term. Its Faculty and roster belong to it alone, not to the Course.
        </Key>
        <Key term="Faculty and roster size">
          Who teaches each offering and how many Students are on its roster: today, in a Term running now. A Term still
          to come shows who starts it, and one that has ended, who finished it.
        </Key>
        <Key term="Label">
          What tells two offerings of one Course in one Term apart, such as Section A and Section B. At most one of them
          goes without.
        </Key>
      </dl>
    </>
  );

  if (term === undefined) {
    return (
      <Sheet {...SHEET} legend={legend}>
        <h1>Class Offerings</h1>
        <p className="empty">
          This School has no Terms yet, and every Class Offering runs in one. Create an Academic Year and divide it into
          Terms on <Link to={{ name: "academicYears", schoolId }}>Academic Years</Link> first.
        </p>
      </Sheet>
    );
  }

  const offered = classOfferings.filter((offering) => offering.term.id === term.id);

  const offer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const courseId = String(fields.get("courseId") ?? "");
    const label = String(fields.get("label") ?? "").trim();
    setProblem(null);
    setDone("");
    const sent = await onOffer({ courseId, termId: term.id, label: label === "" ? null : label });
    const course = courses.find((each) => each.id === courseId)?.name ?? "The Course";
    if (sent.ok) {
      form.reset();
      setDone(`${course} is offered in ${term.name}.`);
    } else if (sent.conflict !== undefined) {
      setProblem(labelConflictMessage(sent.conflict, course, term.name));
    }
  };

  return (
    <Sheet {...SHEET} legend={legend}>
      <h1>Class Offerings</h1>
      <label>
        Term
        <select
          name="termId"
          value={term.id}
          onChange={(event) => {
            setProblem(null);
            setDone("");
            setChosen(event.currentTarget.value);
          }}
        >
          {academicYears
            .filter((year) => year.terms.length > 0)
            .map((year) => (
              <optgroup key={year.id} label={year.name}>
                {year.terms.map((each) => (
                  <option key={each.id} value={each.id}>
                    {each.name}, {year.name}
                  </option>
                ))}
              </optgroup>
            ))}
        </select>
      </label>
      <p className="muted" role="status">
        {done === "" ? `${formatSchoolDate(term.firstDate)} to ${formatSchoolDate(term.lastDate)}` : done}
      </p>

      <CourseChart
        label={`Wall chart of ${term.name}`}
        schoolId={schoolId}
        offerings={offered}
        onPoint={setPointed}
      />

      <RecordList
        label={`Class Offerings in ${term.name}`}
        rows={offered}
        keyOf={(offering) => offering.id}
        dimmed={(offering) => pointed !== null && pointed !== offering.course.id}
        empty={`No Course is offered in ${term.name} yet.${courses.length > 0 ? " Offer one below." : ""}`}
        columns={[
          {
            head: "Course",
            cell: (offering) => (
              <CourseName course={offering.course}>
                <Link to={{ name: "classOffering", schoolId, classOfferingId: offering.id }}>
                  {offeringName(offering)}
                </Link>
              </CourseName>
            ),
          },
          {
            head: "Code",
            cell: (offering) =>
              offering.course.code === null ? <span className="muted">None</span> : <code>{offering.course.code}</code>,
          },
          {
            head: "Faculty",
            cell: ({ faculty }) =>
              faculty.length === 0 ? (
                <span className="muted">No one assigned</span>
              ) : (
                faculty.map((person) => person.displayName).join(", ")
              ),
          },
          {
            head: "Roster",
            cell: ({ rosterSize }) =>
              rosterSize === 0 ? <span className="muted">No Students</span> : studentCount(rosterSize),
          },
        ]}
      />

      <form onSubmit={offer} aria-label={`Offer a Course in ${term.name}`}>
        <h2>Offer a Course in {term.name}</h2>
        {courses.length === 0 ? (
          <p className="empty">
            This School has no Course to offer yet. Define one on{" "}
            <Link to={{ name: "courses", schoolId }}>Courses</Link> first.
          </p>
        ) : (
          <>
            <label>
              Course
              <select name="courseId" required defaultValue="">
                <option value="" disabled>
                  Choose a Course
                </option>
                {courses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {courseTitle(course)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Label (optional)
              <input name="label" maxLength={MAX_NAME_LENGTH} autoComplete="off" placeholder="Section A" />
            </label>
            <p className="muted">
              Offering a Course already offered in {term.name} needs a label to tell the two apart.
            </p>
            {problem !== null && (
              <p role="alert" className="error">
                {problem}
              </p>
            )}
            <button type="submit" disabled={busy}>
              Offer Course
            </button>
          </>
        )}
      </form>
    </Sheet>
  );
}

/**
 * The Term the School is in today, by the reader's own calendar; otherwise the
 * next to begin, or the last to have ended. Undefined only when there is none.
 */
function currentTerm(terms: Term[]): Term | undefined {
  // Today's date, as a date field writes it: the day after yesterday.
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const today = dayAfter(yesterday);
  // `YYYY-MM-DD` sorts as the dates do.
  return (
    terms.find((term) => term.firstDate <= today && today <= term.lastDate) ??
    terms.find((term) => today < term.firstDate) ??
    terms.at(-1)
  );
}

function studentCount(count: number): string {
  return count === 1 ? "1 Student" : `${count} Students`;
}
