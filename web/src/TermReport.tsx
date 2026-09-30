import { useCallback, useState } from "react";
import { api, type ReachedSchool, type TermReport as Report } from "./api.ts";
import { TALLIES, TALLY_NAMES } from "./attendance.ts";
import { CourseName } from "./CourseChart.tsx";
import { NotAvailable } from "./NotAvailable.tsx";
import { offeringName } from "./offerings.ts";
import { RecordList, type Column } from "./RecordList.tsx";
import { useScreen } from "./screen.ts";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";
import { formatSchoolDate } from "./standing.ts";

type Offering = Report["classOfferings"][number];

/**
 * One Student's Term report (CONTEXT.md: Term report): each Class Offering
 * they were rostered in during one Term, with its published Term result and
 * Attendance totals, and a picker for the other Terms they were rostered in.
 *
 * The same page serves the Student their own, as Your Term report, and serves
 * a School Administrator or a Guardian a Student's by name. What each reader
 * sees of it is the server's to decide: a part it leaves out is simply not
 * there, with no column, key or word marking that it was withheld.
 *
 * It reads, and never writes. It prints cleanly from the browser: the print
 * stylesheet drops the shell, the key and every control.
 */
export function TermReport({ school, personId }: { school: ReachedSchool; personId: string }) {
  const own = personId === school.personId;
  const sheet: SheetKind = { name: own ? "Your Term report" : "Term report" };
  const [termId, setTermId] = useState<string | null>(null);
  const read = useCallback(
    async (schoolId: string) => {
      const answered = await api.termReport(schoolId, personId, termId);
      return answered.ok ? { ok: true as const, body: answered.body.termReport } : answered;
    },
    [personId, termId],
  );
  const { showing } = useScreen(school.schoolId, read);

  switch (showing.kind) {
    case "loading":
      return <Sheet {...sheet} busy />;
    case "not-available":
      return <NotAvailable />;
    case "ready":
      return <ReportSheet sheet={sheet} own={own} report={showing.records} onPick={setTermId} />;
  }
}

function ReportSheet({
  sheet,
  own,
  report,
  onPick,
}: {
  sheet: SheetKind;
  own: boolean;
  report: Report;
  onPick: (termId: string) => void;
}) {
  const { student, term, terms, shows } = report;
  const legend = (
    <>
      <h2>Key</h2>
      <p>{own ? "Your own Term report" : `${student.displayName}'s Term report`}, and nothing about anyone else.</p>
      <dl>
        {shows.termResults && (
          <Key term="Term result">
            What the class&rsquo;s Faculty published for the Term. None published yet means nothing has been published
            for that class so far.
          </Key>
        )}
        {shows.attendanceTotals && (
          <Key term="Not recorded">An Instructional day so far, on the roster, with no Attendance recorded.</Key>
        )}
      </dl>
    </>
  );

  return (
    <Sheet {...sheet} legend={legend}>
      <h1>{own ? "Your Term report" : "Term report"}</h1>
      <dl className="facts">
        <dt>Student</dt>
        <dd>{student.displayName}</dd>
        {term !== null && (
          <>
            <dt>Term</dt>
            <dd>
              {term.name}, {term.academicYear.name}: {formatSchoolDate(term.firstDate)} to{" "}
              {formatSchoolDate(term.lastDate)}
            </dd>
          </>
        )}
      </dl>
      {term === null ? (
        <p className="empty">
          {own ? "You are" : `${student.displayName} is`} on no Class Offering&rsquo;s roster yet, so there is no Term
          report to show.
        </p>
      ) : (
        <>
          <div className="report-controls">
            {terms.length > 1 && (
              <label>
                Term
                <select name="termId" value={term.id} onChange={(event) => onPick(event.currentTarget.value)}>
                  {terms.map((each) => (
                    <option key={each.id} value={each.id}>
                      {each.name}, {each.academicYear.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button type="button" className="button-quiet" onClick={() => window.print()}>
              Print
            </button>
          </div>
          {shows.attendanceTotals && (
            <p className="muted">
              Attendance totals from {formatSchoolDate(term.firstDate)} to{" "}
              {formatSchoolDate(report.today < term.lastDate ? report.today : term.lastDate)}.
            </p>
          )}
          <RecordList
            label={`${student.displayName}'s Term report for ${term.name}, ${term.academicYear.name}`}
            rows={report.classOfferings}
            keyOf={(offering) => offering.id}
            empty=""
            columns={columnsFor(shows)}
          />
        </>
      )}
    </Sheet>
  );
}

/** The report's columns: the Class Offering, then only the parts the reader is shown. */
function columnsFor(shows: Report["shows"]): Column<Offering>[] {
  const offering: Column<Offering> = {
    head: "Class Offering",
    cell: (row) => <CourseName course={row.course}>{offeringName(row)}</CourseName>,
  };
  const results: Column<Offering>[] = [
    {
      head: "Term result",
      cell: (row) =>
        row.termResult == null ? <span className="muted">None published yet</span> : row.termResult.value,
    },
    { head: "Score", cell: (row) => row.termResult?.score ?? "" },
    { head: "Comment", cell: (row) => row.termResult?.comment ?? "" },
  ];
  const totals: Column<Offering>[] = TALLIES.map((tally) => ({
    head: TALLY_NAMES[tally],
    cell: (row) => row.attendanceTotals?.[tally] ?? "",
  }));
  return [offering, ...(shows.termResults ? results : []), ...(shows.attendanceTotals ? totals : [])];
}
