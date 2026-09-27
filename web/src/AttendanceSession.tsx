import { useCallback, useState, type FormEvent } from "react";
import {
  api,
  readAll,
  type ApiResult,
  type Attendance,
  type AttendanceSession as Session,
  type AttendanceStatus,
  type ConflictDetail,
  type Mark,
  type ReachedSchool,
  type RefusedMark,
  type TaughtClassOffering as Offering,
} from "./api.ts";
import { Link } from "./Link.tsx";
import { navigate } from "./navigation.ts";
import { NotAvailable } from "./NotAvailable.tsx";
import { offeringName } from "./offerings.ts";
import { RecordList } from "./RecordList.tsx";
import { useScreen } from "./screen.ts";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";
import { formatSchoolDate, MOMENT } from "./standing.ts";

/** Which sheet this page is, named once so its states cannot drift apart. */
const SHEET: SheetKind = { name: "Attendance session" };

/** Every status, in the order the control offers them, as a reader says it. */
const STATUS_NAMES: Record<AttendanceStatus, string> = {
  present: "Present",
  tardy: "Tardy",
  excused_absence: "Excused absence",
  unexcused_absence: "Unexcused absence",
  absent_pending_review: "Absent, pending review",
};

const STATUSES = Object.keys(STATUS_NAMES) as AttendanceStatus[];

/**
 * One Class Offering's Attendance session on one School date: the School's
 * today unless the route names another. It opens from its own URL, so a
 * bookmark to it works.
 *
 * A Faculty member currently teaching the offering on that date, inside its
 * Attendance window, opens it by reading it: the session captures the
 * roster, every Student unmarked. They mark each Student, or every unmarked
 * one Present at once, and save with any left unmarked. A mark a co-teacher
 * changed since this page read it is refused and shown in place with its
 * newer value, never overwritten.
 *
 * Anyone else who may read it — a School Administrator, a Faculty member
 * whose assignment has ended — reads it with why they cannot record it said
 * plainly, as does a Faculty member on a date that cannot be recorded. Anyone
 * else again, and an offering that does not exist or is another School's, is
 * the one "not available" state (ADR-0002).
 */
export function AttendanceSession({
  school,
  classOfferingId,
  date,
}: {
  school: ReachedSchool;
  classOfferingId: string;
  date: string | null;
}) {
  const { schoolId } = school;
  // Stable for as long as the page shows one session, so it is read once and again only after a change.
  const read = useCallback(
    async (schoolId: string): Promise<ApiResult<{ classOffering: Offering; attendanceSession: Session }>> => {
      const answered = await readAll([
        api.classOffering(schoolId, classOfferingId),
        api.attendanceSession(schoolId, classOfferingId, date),
      ]);
      if (!answered.ok) {
        return answered;
      }
      const [{ classOffering }, { attendanceSession }] = answered.body;
      // Reading a session the actor may record, that nobody has opened, opens it.
      if (attendanceSession.opened === null && attendanceSession.readOnlyBecause === null) {
        const opened = await api.openAttendanceSession(schoolId, classOfferingId, attendanceSession.date);
        return opened.ok ? { ok: true, body: { classOffering, ...opened.body } } : { ok: false };
      }
      return { ok: true, body: { classOffering, attendanceSession } };
    },
    [classOfferingId, date],
  );
  const { showing, busy, change } = useScreen(schoolId, read);

  switch (showing.kind) {
    case "loading":
      return <Sheet {...SHEET} busy />;
    case "not-available":
      return <NotAvailable />;
    case "ready": {
      const { classOffering, attendanceSession } = showing.records;
      return (
        <SessionSheet
          // A fresh sheet for each date, so nothing chosen for one carries to another.
          key={attendanceSession.date}
          schoolId={schoolId}
          administers={school.roles.includes("school_administrator")}
          offering={classOffering}
          session={attendanceSession}
          busy={busy}
          onSave={(save) => change(() => api.saveAttendance(schoolId, classOfferingId, save))}
          onRefresh={() => change(() => api.openAttendanceSession(schoolId, classOfferingId, attendanceSession.date))}
        />
      );
    }
  }
}

function SessionSheet({
  schoolId,
  administers,
  offering,
  session,
  busy,
  onSave,
  onRefresh,
}: {
  schoolId: string;
  administers: boolean;
  offering: Offering;
  session: Session;
  busy: boolean;
  onSave: (save: {
    date: string;
    marks: Mark[];
    markAllPresent?: boolean;
  }) => Promise<ApiResult<{ attendanceSession: Session; refusedMarks: RefusedMark[] }>>;
  onRefresh: () => Promise<ApiResult<{ attendanceSession: Session }>>;
}) {
  /** The statuses chosen and not yet saved, by Student. */
  const [drafts, setDrafts] = useState<ReadonlyMap<string, AttendanceStatus>>(new Map());
  /** The marks the last save refused, by Student, said beside each until the next save. */
  const [refused, setRefused] = useState<ReadonlyMap<string, RefusedMark>>(new Map());
  /** What the last change did, said once so a screen reader hears it land. */
  const [done, setDone] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const { date, today, readOnlyBecause } = session;
  const recordable = readOnlyBecause === null;
  const on = formatSchoolDate(date);
  const markable = (student: Session["students"][number]) =>
    recordable && student.unmarkableBecause === null && student.attendance?.status !== "absent_pending_review";
  const unmarked = session.students.filter(
    (student) => markable(student) && student.attendance === null && !drafts.has(student.person.id),
  ).length;

  const why = readOnlyText(session, { administers, termName: offering.term.name });

  const choose = (studentId: string, status: AttendanceStatus) => {
    setDrafts((held) => new Map(held).set(studentId, status));
  };

  const send = async (markAllPresent: boolean) => {
    setDone("");
    setProblem(null);
    const loaded = new Map(session.students.map((student) => [student.person.id, student.attendance?.status ?? null]));
    const marks = [...drafts].map(([studentPersonId, status]) => ({
      studentPersonId,
      loaded: loaded.get(studentPersonId) ?? null,
      status,
    }));
    const sent = await onSave({ date, marks, ...(markAllPresent ? { markAllPresent } : {}) });
    if (sent.ok) {
      setDrafts(new Map());
      const { refusedMarks } = sent.body;
      setRefused(new Map(refusedMarks.map((mark) => [mark.studentPersonId, mark])));
      const saved = markAllPresent ? "Saved, and every unmarked Student is marked Present." : "Saved.";
      setDone(
        refusedMarks.length === 0
          ? saved
          : `${saved} ${refusedMarks.length === 1 ? "One mark was" : `${refusedMarks.length} marks were`} not saved: see beside ${refusedMarks.length === 1 ? "it" : "each"}.`,
      );
    } else if (sent.conflict !== undefined) {
      setDrafts(new Map());
      setProblem(conflictMessage(sent.conflict));
    }
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await send(false);
  };

  const refresh = async () => {
    setDone("");
    setProblem(null);
    const before = session.students.length;
    const sent = await onRefresh();
    if (sent.ok) {
      const added = sent.body.attendanceSession.students.length - before;
      setDone(
        added === 0
          ? "The roster is up to date: no Student has been rostered since it was captured."
          : `${added === 1 ? "One Student" : `${added} Students`} rostered since the session opened ${added === 1 ? "is" : "are"} added.`,
      );
    } else if (sent.conflict !== undefined) {
      setProblem(conflictMessage(sent.conflict));
    }
  };

  const pick = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const picked = String(new FormData(event.currentTarget).get("date") ?? "");
    if (picked !== "") {
      navigate({ name: "attendanceOn", schoolId, classOfferingId: offering.id, date: picked });
    }
  };

  const legend = (
    <>
      <h2>Key</h2>
      <p>One class&rsquo;s Attendance on one School date, taken by whoever teaches it.</p>
      <dl>
        <Key term="Attendance session">
          The one session for this class on this date, shared by everyone teaching it. A mark someone else changed
          after you opened it is not overwritten: it is shown to you with its newer value.
        </Key>
        <Key term="Roster snapshot">
          The Students on the roster when the session opened. Refreshing adds any rostered since, and never takes one
          away.
        </Key>
        <Key term="Unmarked">Not yet recorded. A session saves with Students still unmarked.</Key>
        <Key term="Absent, pending review">
          Absent for a reason not yet known. A School Administrator settles it, so it cannot be changed here.
        </Key>
        <Key term="Attendance window">
          How many days after a date its Attendance can still be recorded here. After that, a change needs a
          Correction request.
        </Key>
      </dl>
    </>
  );

  return (
    <Sheet
      {...SHEET}
      legend={legend}
      foot={
        <p>
          <Link to={{ name: "classOffering", schoolId, classOfferingId: offering.id }}>{offeringName(offering)}</Link>
        </p>
      }
    >
      <h1>{offeringName(offering)}</h1>
      <dl className="facts">
        <dt>School date</dt>
        <dd>{date === today ? `${on}, today` : on}</dd>
        <dt>Recordable until</dt>
        <dd>{formatSchoolDate(session.lastRecordableDate)}</dd>
        <dt>Opened</dt>
        <dd>
          {session.opened === null ? (
            <span className="muted">Not yet</span>
          ) : (
            `By ${session.opened.by.displayName}, ${MOMENT.format(new Date(session.opened.at))}`
          )}
        </dd>
      </dl>

      <form onSubmit={pick} aria-label="Choose a School date">
        <label>
          School date
          <input
            // Keyed by the date shown, so the field shows it afresh on another.
            key={date}
            type="date"
            name="date"
            required
            defaultValue={date}
            min={offering.term.firstDate}
            max={[offering.term.lastDate, today].sort()[0]}
          />
        </label>
        <button type="submit" className="button-quiet">
          Open this date
        </button>
      </form>

      {why !== null && <p className="notice">{why}</p>}

      <form onSubmit={save} aria-label="Take attendance">
        <h2>Attendance</h2>
        <RecordList
          label="Attendance"
          rows={session.students}
          keyOf={(student) => student.person.id}
          empty={
            session.opened === null
              ? "Nobody has opened this session."
              : `No Student was on this roster on ${on}.`
          }
          columns={[
            {
              head: "Student",
              cell: (student) => (
                <>
                  {student.person.displayName}
                  {student.unmarkableBecause !== null && (
                    <>
                      {" "}
                      <span className="mark mark--struck">
                        {student.unmarkableBecause === "enrollment_ended"
                          ? "Enrollment ended before this date"
                          : "Not rostered on this date"}
                      </span>
                    </>
                  )}
                </>
              ),
            },
            {
              head: "Status",
              cell: (student) => {
                const refusal = refused.get(student.person.id);
                const noteId = `refused-${student.person.id}`;
                const current = student.attendance?.status;
                return (
                  <>
                    {markable(student) ? (
                      <select
                        aria-label={`${student.person.displayName}’s status`}
                        aria-describedby={refusal === undefined ? undefined : noteId}
                        disabled={busy}
                        value={drafts.get(student.person.id) ?? current ?? ""}
                        onChange={(event) => choose(student.person.id, event.currentTarget.value as AttendanceStatus)}
                      >
                        {current === undefined && (
                          <option value="" disabled>
                            Unmarked
                          </option>
                        )}
                        {STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {STATUS_NAMES[status]}
                          </option>
                        ))}
                      </select>
                    ) : current === undefined ? (
                      <span className="muted">Unmarked</span>
                    ) : (
                      STATUS_NAMES[current]
                    )}
                    {refusal !== undefined && (
                      <p id={noteId} className="error">
                        {refusalText(refusal)}
                      </p>
                    )}
                  </>
                );
              },
            },
            {
              head: "Recorded",
              cell: (student) => recordedText(student.attendance),
            },
          ]}
        />
        {problem !== null && (
          <p role="alert" className="error">
            {problem}
          </p>
        )}
        {recordable && session.students.length > 0 && (
          <p className="actions">
            <button type="submit" disabled={busy || drafts.size === 0}>
              Save
            </button>
            <button
              type="button"
              className="button-quiet"
              disabled={busy || unmarked === 0}
              onClick={() => void send(true)}
            >
              Mark all Present
            </button>
          </p>
        )}
        {recordable && (
          <p className="actions">
            <button type="button" className="button-quiet" disabled={busy} onClick={() => void refresh()}>
              Refresh roster
            </button>
          </p>
        )}
      </form>
      <p className="muted" role="status">
        {done}
      </p>
    </Sheet>
  );
}

/** Who last recorded a mark and when, or that nobody has. */
function recordedText(attendance: Attendance | null): string {
  return attendance === null
    ? "Not yet"
    : `${attendance.recordedBy.displayName}, ${MOMENT.format(new Date(attendance.recordedAt))}`;
}

/** Why the actor reads this session and cannot record it, or null when they can. */
function readOnlyText(session: Session, { administers, termName }: { administers: boolean; termName: string }) {
  const on = formatSchoolDate(session.date);
  switch (session.readOnlyBecause) {
    case null:
      return null;
    case "not_instructional_day":
      return `${on} is not an Instructional day in ${termName}, so no Attendance is taken on it.`;
    case "after_today":
      return `${on} has not come yet. Attendance is taken on the day, or after it.`;
    case "not_teaching":
      return administers
        ? "School Administrators read Attendance here. A change of theirs goes through a Correction request."
        : "You are not teaching this class now, so you can read its Attendance but not record it.";
    case "not_taught_on_date":
      return `Your Teaching assignment did not cover ${on}, so you can read its Attendance but not record it.`;
    case "attendance_window_closed":
      return `The Attendance window for ${on} closed after ${formatSchoolDate(session.lastRecordableDate)}. A change now needs a Correction request.`;
  }
}

/** Why one mark was not saved, beside the Student it was for. */
function refusalText({ because, attendance }: RefusedMark): string {
  switch (because) {
    case "stale":
      return attendance === null
        ? "This mark changed after you opened the session. Your change was not saved."
        : `${attendance.recordedBy.displayName} marked this ${STATUS_NAMES[attendance.status]} at ${MOMENT.format(new Date(attendance.recordedAt))}, after you opened the session. Your change was not saved.`;
    case "absent_pending_review":
      return "Absent, pending review is settled by a School Administrator. Your change was not saved.";
    case "not_markable":
      return "This Student cannot be marked on this date. Your change was not saved.";
  }
}

/** Why a save or refresh changed nothing, in the words of the rule. */
function conflictMessage(conflict: ConflictDetail): string {
  switch (conflict.conflict) {
    case "attendance_window_closed":
      return "The Attendance window for this date has closed, so nothing was saved. A change now needs a Correction request.";
    case "after_today":
      return "This date has not come yet, so nothing was saved.";
    case "not_instructional_day":
      return "This date is no longer an Instructional day, so nothing was saved.";
    default:
      return "That change could not be made.";
  }
}
