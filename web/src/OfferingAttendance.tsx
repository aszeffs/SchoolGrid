import { useId } from "react";
import type { ClassOfferingAttendance } from "./api.ts";
import { STATUS_LETTERS, STATUS_NAMES, STATUSES, TALLIES, TALLY_NAMES } from "./attendance.ts";
import { Link } from "./Link.tsx";
import { RecordList } from "./RecordList.tsx";
import { formatSchoolDate, formatSchoolDateShort } from "./standing.ts";

type Student = ClassOfferingAttendance["students"][number];

const NOBODY_ROSTERED = "No Student has been on this roster.";

/**
 * A Class Offering's Attendance on its own page: each Student's Attendance
 * totals for the Term so far, and every mark by date.
 *
 * The totals are a record list, read down at a phone's width. The grid keeps
 * its Students down the side and its dates across, as a class list does; a Term
 * of dates is wider than any screen, so it scrolls across inside its own
 * frame, which takes the keyboard's focus to be scrolled, and the page itself
 * never does. Each date's head opens that date's Attendance session.
 */
export function OfferingAttendance({
  schoolId,
  classOfferingId,
  termLastDate,
  attendance,
}: {
  schoolId: string;
  classOfferingId: string;
  termLastDate: string;
  attendance: ClassOfferingAttendance;
}) {
  const gridId = useId();
  const { dates, students } = attendance;

  return (
    <section>
      <h2>Attendance</h2>
      <p>
        <Link to={{ name: "attendance", schoolId, classOfferingId }}>Today&rsquo;s Attendance session</Link>{" "}
        <span className="muted">Another School date can be chosen there, or from a date below.</span>
      </p>

      <h3>Totals</h3>
      <RecordList
        label="Attendance totals"
        rows={students}
        keyOf={(student) => student.person.id}
        empty={NOBODY_ROSTERED}
        columns={[
          { head: "Student", cell: (student) => student.person.displayName },
          ...TALLIES.map((tally) => ({ head: TALLY_NAMES[tally], cell: (student: Student) => student.totals[tally] })),
        ]}
      />

      <h3 id={gridId}>By date</h3>
      {dates.length === 0 ? (
        <p className="empty">No Instructional day of this Term has come yet.</p>
      ) : students.length === 0 ? (
        <p className="empty">{NOBODY_ROSTERED}</p>
      ) : (
        <>
          <div className="attendance-grid" role="region" aria-labelledby={gridId} tabIndex={0}>
            <table className="attendance-grid__grid">
              <caption className="unprinted">
                Each Student&rsquo;s Attendance by School date, from {formatSchoolDate(dates[0]!.date)} to{" "}
                {formatSchoolDate(dates.at(-1)!.date)}.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Student</th>
                  {dates.map(({ date, instructional }) => (
                    <th key={date} scope="col">
                      <Link to={{ name: "attendanceOn", schoolId, classOfferingId, date }}>
                        {formatSchoolDateShort(date)}
                      </Link>
                      {!instructional && <span className="attendance-grid__uncounted">Not counted</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {students.map((student) => {
                  const markOn = new Map(student.attendance.map((mark) => [mark.date, mark.status]));
                  const rostered = (date: string) =>
                    student.rosterMemberships.some(
                      ({ firstDate, lastDate }) => firstDate <= date && date <= (lastDate ?? termLastDate),
                    );
                  return (
                    <tr key={student.person.id}>
                      <th scope="row">{student.person.displayName}</th>
                      {dates.map(({ date, instructional }) => {
                        const status = markOn.get(date);
                        if (status !== undefined) {
                          return (
                            <td key={date} data-status={status} title={STATUS_NAMES[status]}>
                              <span aria-hidden="true">{STATUS_LETTERS[status]}</span>
                              <span className="unprinted">{STATUS_NAMES[status]}</span>
                            </td>
                          );
                        }
                        if (instructional && rostered(date)) {
                          return (
                            <td key={date} title="Not recorded">
                              <span aria-hidden="true">&ndash;</span>
                              <span className="unprinted">Not recorded</span>
                            </td>
                          );
                        }
                        return (
                          <td key={date}>
                            <span className="unprinted">Not on the roster</span>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted attendance-grid__key">
            {STATUSES.map((status) => `${STATUS_LETTERS[status]} ${STATUS_NAMES[status]}`).join(" · ")}{" "}
            · &ndash; Not recorded. A blank is a day off the roster.
          </p>
        </>
      )}
    </section>
  );
}
