import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { Weekday } from "../../src/calendar/index.ts";
import { MAX_NAME_LENGTH } from "../../src/validation/bounds.ts";
import {
  api,
  type AcademicYear,
  type ApiResult,
  type ConflictDetail,
  type InstructionalDayException,
  type ProposedException,
  type ProposedTerm,
  type ReachedSchool,
} from "./api.ts";
import { ConfirmDialog } from "./Dialog.tsx";
import { dayCount, InstructionalDays } from "./InstructionalDays.tsx";
import { Link } from "./Link.tsx";
import { NotAvailable } from "./NotAvailable.tsx";
import { RecordList } from "./RecordList.tsx";
import { useScreen } from "./screen.ts";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";
import { schoolDateAfter, schoolDay } from "./standing.ts";

/** Which sheet this page is, named once so its states cannot drift apart. */
const SHEET: SheetKind = { name: "Academic Years" };

type Change = { name: string; firstDate: string; lastDate: string; terms: ProposedTerm[] };

/**
 * A School's Academic Years, each with the Terms that divide it and its
 * Instructional days, in date order: where a School Administrator plans the
 * School's calendar.
 *
 * A year's Terms are edited together with the year and sent as one change, so
 * moving the boundary between two Terms, or the year's own first or last day,
 * is one step that lands whole or not at all.
 *
 * The session names this page to a School Administrator only (ADR-0007), and
 * the server refuses anyone else with the one "not available" state.
 */
export function AcademicYears({ school }: { school: ReachedSchool }) {
  const { schoolId } = school;
  const { showing, busy, change } = useScreen(schoolId, api.academicYears);

  switch (showing.kind) {
    case "loading":
      return <Sheet {...SHEET} busy />;
    case "not-available":
      return <NotAvailable />;
    case "ready":
      return (
        <AcademicYearsSheet
          years={showing.records.academicYears}
          schoolId={schoolId}
          busy={busy}
          onCreate={(year) => change(() => api.createAcademicYear(schoolId, year))}
          onChange={(year, proposed) => change(() => api.changeAcademicYear(schoolId, year.id, proposed))}
          onDelete={(year) => change(() => api.deleteAcademicYear(schoolId, year.id))}
          onSetPattern={(year, weekdays) => change(() => api.setWeekdayPattern(schoolId, year.id, weekdays))}
          onAddException={(year, exception) =>
            change(() => api.addInstructionalDayException(schoolId, year.id, exception))
          }
          onRemoveException={(year, exception) =>
            change(() => api.removeInstructionalDayException(schoolId, year.id, exception.id))
          }
        />
      );
  }
}

function AcademicYearsSheet({
  years,
  schoolId,
  busy,
  onCreate,
  onChange,
  onDelete,
  onSetPattern,
  onAddException,
  onRemoveException,
}: {
  years: AcademicYear[];
  schoolId: string;
  busy: boolean;
  onCreate: (year: { name: string; firstDate: string; lastDate: string }) => Promise<ApiResult<unknown>>;
  onChange: (year: AcademicYear, proposed: Change) => Promise<ApiResult<unknown>>;
  onDelete: (year: AcademicYear) => Promise<ApiResult<unknown>>;
  onSetPattern: (year: AcademicYear, weekdays: Weekday[]) => Promise<ApiResult<unknown>>;
  onAddException: (year: AcademicYear, exception: ProposedException) => Promise<ApiResult<unknown>>;
  onRemoveException: (year: AcademicYear, exception: InstructionalDayException) => Promise<ApiResult<unknown>>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AcademicYear | null>(null);
  /** A year whose editor or dialog just closed, so its Change control takes the focus back. */
  const [returning, setReturning] = useState<string | null>(null);
  /** Why the last deletion or creation changed nothing, keyed by the year it was about, or "new". */
  const [problem, setProblem] = useState<{ about: string; message: string } | null>(null);
  /** What the last change did, said once so a screen reader hears it land. */
  const [done, setDone] = useState("");

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const year = {
      name: String(fields.get("name") ?? ""),
      firstDate: String(fields.get("firstDate") ?? ""),
      lastDate: String(fields.get("lastDate") ?? ""),
    };
    setProblem(null);
    setDone("");
    const sent = await onCreate(year);
    if (sent.ok) {
      form.reset();
      setDone(`${year.name} is created. Divide it into Terms with Change.`);
    } else if (sent.conflict !== undefined) {
      setProblem({ about: "new", message: conflictMessage(sent.conflict, "create") });
    }
  };

  const legend = (
    <>
      <h2>Key</h2>
      <p>The periods this School plans its teaching in.</p>
      <dl>
        <Key term="Academic Year">
          A named period with a first and last day. Years never share a day, but may leave days between them, such as a
          summer break.
        </Key>
        <Key term="Term">
          A part of an Academic Year. A year&rsquo;s Terms run in order from its first day to its last, with no gap and
          no day in two Terms.
        </Key>
        <Key term="Not yet divided">A year with no Terms. Class Offerings will run in Terms, so divide it first.</Key>
        <Key term="Instructional day">
          A day the School is in session: a weekday of the year&rsquo;s pattern, unless it is taken out. Marked with a
          filled dot.
        </Key>
        <Key term="Holiday">A day of the pattern taken out. Framed, and marked with a struck ring.</Key>
        <Key term="Make-up day">A day outside the pattern put in. Framed, and marked with a filled dot.</Key>
        <Key term="Timezone">
          Once the first Academic Year exists, the School&rsquo;s timezone is fixed, so no day already planned moves.
        </Key>
      </dl>
    </>
  );

  return (
    <Sheet {...SHEET} legend={legend}>
      <h1>Academic Years</h1>
      <p className="muted" role="status">
        {done}
      </p>

      {years.length === 0 ? (
        <p className="empty">
          This School has no Academic Year yet. Create the first one below, then divide it into Terms.
        </p>
      ) : (
        years.map((year) =>
          editing === year.id ? (
            <YearEditor
              key={year.id}
              year={year}
              busy={busy}
              onCancel={() => {
                setEditing(null);
                setReturning(year.id);
              }}
              onSave={async (proposed) => {
                setDone("");
                const sent = await onChange(year, proposed);
                if (sent.ok) {
                  setEditing(null);
                  setReturning(year.id);
                  setDone(`${proposed.name} is saved.`);
                }
                return sent;
              }}
            />
          ) : (
            <YearRecord
              key={year.id}
              year={year}
              busy={busy || editing !== null}
              focusChange={returning === year.id}
              problem={problem?.about === year.id ? problem.message : null}
              say={setDone}
              onSetPattern={(weekdays) => onSetPattern(year, weekdays)}
              onAddException={(exception) => onAddException(year, exception)}
              onRemoveException={(exception) => onRemoveException(year, exception)}
              onEdit={() => {
                setProblem(null);
                setDone("");
                setEditing(year.id);
              }}
              onDelete={() => {
                setProblem(null);
                setDone("");
                setDeleting(year);
              }}
            />
          ),
        )
      )}

      <form onSubmit={create} aria-label="Create an Academic Year">
        <h2>Create an Academic Year</h2>
        <YearFields />
        <p className="muted">
          It starts undivided; add its Terms once it exists. The School&rsquo;s timezone, on{" "}
          <Link to={{ name: "settings", schoolId }}>Settings</Link>, is fixed from then on.
        </p>
        {problem?.about === "new" && (
          <p role="alert" className="error">
            {problem.message}
          </p>
        )}
        <button type="submit" disabled={busy || editing !== null}>
          Create Academic Year
        </button>
      </form>

      {deleting !== null && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          confirm="Delete the Academic Year"
          busy={busy}
          onCancel={() => {
            setDeleting(null);
            setReturning(deleting.id);
          }}
          onConfirm={async () => {
            const year = deleting;
            setDeleting(null);
            const sent = await onDelete(year);
            if (sent.ok) {
              setDone(`${year.name} is deleted.`);
            } else if (sent.conflict !== undefined) {
              setReturning(year.id);
              setProblem({ about: year.id, message: conflictMessage(sent.conflict, "delete") });
            }
          }}
        >
          {deleting.terms.length > 0 ? (
            <p>
              {deleting.name} is divided into {termCount(deleting.terms.length)}. A year is not deleted while it has
              Terms: remove them with Change first.
            </p>
          ) : deleting.exceptions.length > 0 ? (
            <p>
              {deleting.name} has days taken out or put in. A year is not deleted while it has any: return each to the
              weekday pattern first.
            </p>
          ) : (
            <p>
              {deleting.name}, from {schoolDay(deleting.firstDate)} to {schoolDay(deleting.lastDate)}, is removed.
              Nothing else refers to it yet.
            </p>
          )}
        </ConfirmDialog>
      )}
    </Sheet>
  );
}

/**
 * One year as it stands, with its Terms in order, its Instructional days, and
 * the ways to change or delete it.
 */
function YearRecord({
  year,
  busy,
  focusChange,
  problem,
  say,
  onEdit,
  onDelete,
  onSetPattern,
  onAddException,
  onRemoveException,
}: {
  year: AcademicYear;
  busy: boolean;
  focusChange: boolean;
  problem: string | null;
  say: (message: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onSetPattern: (weekdays: Weekday[]) => Promise<ApiResult<unknown>>;
  onAddException: (exception: ProposedException) => Promise<ApiResult<unknown>>;
  onRemoveException: (exception: InstructionalDayException) => Promise<ApiResult<unknown>>;
}) {
  const headingId = useId();
  const change = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusChange) {
      change.current?.focus();
    }
  }, [focusChange]);

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId}>{year.name}</h2>
      <p>
        {schoolDay(year.firstDate)} to {schoolDay(year.lastDate)}
      </p>
      <RecordList
        label={`Terms of ${year.name}`}
        rows={year.terms}
        keyOf={(term) => term.id}
        empty={
          <>
            <span className="mark">Not yet divided</span> This year has no Terms. Add them with Change.
          </>
        }
        columns={[
          { head: "Term", cell: (term) => term.name },
          { head: "First day", cell: (term) => schoolDay(term.firstDate) },
          { head: "Last day", cell: (term) => schoolDay(term.lastDate) },
          {
            head: "Instructional days",
            // The server's list, counted within the Term's bounds: `YYYY-MM-DD` sorts as the dates do.
            cell: (term) =>
              dayCount(year.instructionalDays.filter((day) => term.firstDate <= day && day <= term.lastDate).length),
          },
        ]}
      />
      {problem !== null && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <p className="actions">
        <button
          ref={change}
          type="button"
          className="button-quiet"
          disabled={busy}
          aria-label={`Change ${year.name}`}
          onClick={onEdit}
        >
          Change
        </button>
        <button
          type="button"
          className="button-stamp"
          disabled={busy}
          aria-label={`Delete ${year.name}`}
          onClick={onDelete}
        >
          Delete
        </button>
      </p>
      <InstructionalDays
        year={year}
        busy={busy}
        say={say}
        onSetPattern={onSetPattern}
        onAddException={onAddException}
        onRemoveException={onRemoveException}
      />
    </section>
  );
}

/** A Term being edited. `key` tells rows apart while none of them has been saved. */
type Draft = ProposedTerm & { key: number };

/**
 * A year and its Terms, edited in place and saved as one change.
 *
 * The Terms stay joined as they are edited. The first begins on the year's
 * first day and the last ends on its last, so moving either of the year's
 * bounds moves that Term with it; and a Term's last day sets the next Term's
 * first day, so moving a boundary is one edit. The server still checks the
 * whole, and a set that would not cover the year is refused and said why.
 */
function YearEditor({
  year,
  busy,
  onCancel,
  onSave,
}: {
  year: AcademicYear;
  busy: boolean;
  onCancel: () => void;
  onSave: (proposed: Change) => Promise<ApiResult<unknown>>;
}) {
  const [name, setName] = useState(year.name);
  const [firstDate, setFirstDate] = useState(year.firstDate);
  const [lastDate, setLastDate] = useState(year.lastDate);
  const nextKey = useRef(year.terms.length);
  const [terms, setTerms] = useState<Draft[]>(year.terms.map((term, key) => ({ ...term, key })));
  const [problem, setProblem] = useState<string | null>(null);

  const setBound = (bound: "firstDate" | "lastDate", value: string) => {
    if (bound === "firstDate") {
      setFirstDate(value);
      setTerms((drafts) => drafts.map((draft, index) => (index === 0 ? { ...draft, firstDate: value } : draft)));
    } else {
      setLastDate(value);
      setTerms((drafts) =>
        drafts.map((draft, index) => (index === drafts.length - 1 ? { ...draft, lastDate: value } : draft)),
      );
    }
  };

  const setTerm = (at: number, field: "name" | "firstDate" | "lastDate", value: string) => {
    setTerms((drafts) =>
      drafts.map((draft, index) => {
        if (index === at) {
          return { ...draft, [field]: value };
        }
        // The next Term starts the day after this one ends.
        if (field === "lastDate" && index === at + 1 && value !== "") {
          return { ...draft, firstDate: schoolDateAfter(value) };
        }
        return draft;
      }),
    );
  };

  const addTerm = () => {
    const previous = terms.at(-1);
    const key = nextKey.current++;
    setTerms([
      ...terms.map((draft, index) =>
        // The Term that ended the year gives up its last day for the new one to be set.
        index === terms.length - 1 ? { ...draft, lastDate: "" } : draft,
      ),
      { key, name: "", firstDate: previous === undefined ? firstDate : "", lastDate },
    ]);
  };

  const removeTerm = (at: number) => {
    setTerms((drafts) => {
      const kept = drafts.filter((_, index) => index !== at);
      // Whatever the removed Term covered goes to the Term before it, or the one after if it was first.
      return kept.map((draft, index) => {
        if (at > 0 && index === at - 1) {
          return { ...draft, lastDate: drafts[at]!.lastDate };
        }
        if (at === 0 && index === 0) {
          return { ...draft, firstDate };
        }
        return draft;
      });
    });
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setProblem(null);
    const sent = await onSave({
      name,
      firstDate,
      lastDate,
      terms: terms.map(({ key: _key, ...term }) => term),
    });
    if (!sent.ok && sent.conflict !== undefined) {
      setProblem(conflictMessage(sent.conflict, "change"));
    }
  };

  return (
    <form onSubmit={save} aria-label={`Change ${year.name}`}>
      <h2>Change {year.name}</h2>
      <label>
        Name
        {/* The editor opens where the year was, so the focus goes to its first field. */}
        <input
          name="name"
          required
          maxLength={MAX_NAME_LENGTH}
          autoComplete="off"
          autoFocus
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <label>
        First day
        <input
          type="date"
          name="firstDate"
          required
          value={firstDate}
          onChange={(event) => setBound("firstDate", event.currentTarget.value)}
        />
      </label>
      <label>
        Last day
        <input
          type="date"
          name="lastDate"
          required
          min={firstDate}
          value={lastDate}
          onChange={(event) => setBound("lastDate", event.currentTarget.value)}
        />
      </label>

      <fieldset>
        <legend>Terms</legend>
        <p className="muted">
          The first Term begins on the year&rsquo;s first day and the last ends on its last. Changing a Term&rsquo;s
          last day moves the next Term&rsquo;s first day with it.
        </p>
        {terms.length === 0 && <p className="empty">Not yet divided. Add the first Term.</p>}
        {terms.map((term, index) => (
          <fieldset key={term.key} className="term-draft">
            <legend>Term {index + 1}</legend>
            <label>
              Name
              <input
                required
                maxLength={MAX_NAME_LENGTH}
                autoComplete="off"
                value={term.name}
                onChange={(event) => setTerm(index, "name", event.currentTarget.value)}
              />
            </label>
            <label>
              First day
              <input
                type="date"
                required
                min={firstDate}
                max={lastDate}
                value={term.firstDate}
                onChange={(event) => setTerm(index, "firstDate", event.currentTarget.value)}
              />
            </label>
            <label>
              Last day
              <input
                type="date"
                required
                min={term.firstDate === "" ? firstDate : term.firstDate}
                max={lastDate}
                value={term.lastDate}
                onChange={(event) => setTerm(index, "lastDate", event.currentTarget.value)}
              />
            </label>
            <button type="button" className="button-quiet" disabled={busy} onClick={() => removeTerm(index)}>
              Remove Term {index + 1}
            </button>
          </fieldset>
        ))}
        <button type="button" className="button-ghost" disabled={busy} onClick={addTerm}>
          Add a Term
        </button>
      </fieldset>

      {problem !== null && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <p className="actions">
        <button type="button" className="button-ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={busy}>
          Save changes
        </button>
      </p>
    </form>
  );
}

/** A name and a first and last day, as a new year is created with. */
function YearFields() {
  const [firstDate, setFirstDate] = useState("");
  return (
    <>
      <label>
        Name
        <input name="name" required maxLength={MAX_NAME_LENGTH} autoComplete="off" placeholder="2026–27" />
      </label>
      <label>
        First day
        <input type="date" name="firstDate" required onChange={(event) => setFirstDate(event.currentTarget.value)} />
      </label>
      <label>
        Last day
        <input type="date" name="lastDate" required min={firstDate === "" ? undefined : firstDate} />
      </label>
    </>
  );
}

function termCount(count: number): string {
  return count === 1 ? "1 Term" : `${count} Terms`;
}

/** Why a change to the School's calendar changed nothing, in the words of the rule it would have broken. */
function conflictMessage(conflict: ConflictDetail, attempt: "create" | "change" | "delete"): string {
  switch (conflict.conflict) {
    case "academic_year_overlap":
      return "Those dates share a day with another Academic Year. Years may leave days between them, but never share one.";
    case "term_overlap":
      return "Two Terms share a day. Each day of the year falls in exactly one Term.";
    case "term_gap":
      return "The Terms leave days of the year in no Term. They must run from the year's first day to its last, each starting the day after the one before ends.";
    case "term_outside_academic_year":
      return "A Term falls outside the year. Every Term runs between the year's first and last days.";
    case "dependent":
      if (conflict.dependent === "teaching_assignment") {
        return "A Teaching assignment would fall outside its Term's new dates. Change or end the assignment on its Class Offering first.";
      }
      if (conflict.dependent === "class_offering") {
        return "A Term these changes would remove has Class Offerings, and a Term is not deleted while it has any. Keep the Term, or delete its Class Offerings first.";
      }
      if (conflict.dependent === "instructional_day_exception") {
        return attempt === "delete"
          ? "This year still has days taken out or put in, and a year is not deleted while it has any. Return each to the weekday pattern first."
          : "A day taken out or put in would fall outside the year's new dates. Return it to the weekday pattern first.";
      }
      return attempt === "delete"
        ? "This year still has Terms, and a year is not deleted while it has any. Remove its Terms with Change first."
        : "The year's Terms would no longer fit its dates. Change them together with the year.";
    case "exception_outside_academic_year":
      return "That day falls outside the year.";
    case "exception_date_taken":
      return "That day is already taken out or put in.";
    case "timezone_fixed":
      return "The School's timezone is fixed.";
    // Not rules this page's changes can break.
    case "course_name_taken":
    case "course_code_taken":
    case "class_offering_label_taken":
    case "teaching_assignment_overlap":
    case "teaching_assignment_outside_term":
      return "That change could not be made.";
  }
}
