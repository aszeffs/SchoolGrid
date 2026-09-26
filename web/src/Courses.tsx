import { useEffect, useRef, useState, type FormEvent } from "react";
import { MAX_NAME_LENGTH } from "../../src/validation/bounds.ts";
import { api, readAll, type ApiResult, type ConflictDetail, type Course, type ReachedSchool } from "./api.ts";
import { CourseName } from "./CourseChart.tsx";
import { ConfirmDialog } from "./Dialog.tsx";
import { Link } from "./Link.tsx";
import { NotAvailable } from "./NotAvailable.tsx";
import { RecordList } from "./RecordList.tsx";
import { useScreen } from "./screen.ts";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";

/** Which sheet this page is, named once so its states cannot drift apart. */
const SHEET: SheetKind = { name: "Courses" };

type Proposed = { name: string; code: string | null };

/** The School's Courses, with how many Class Offerings offer each, so a deletion can say why it would be refused. */
async function list(schoolId: string) {
  const answered = await readAll([api.courses(schoolId), api.classOfferings(schoolId)]);
  if (!answered.ok) {
    return answered;
  }
  const [{ courses }, { classOfferings }] = answered.body;
  const offered = new Map<string, number>();
  for (const offering of classOfferings) {
    offered.set(offering.course.id, (offered.get(offering.course.id) ?? 0) + 1);
  }
  return { ok: true as const, body: { courses, offered } };
}

/**
 * A School's Courses by name: the subjects it teaches, each defined once and
 * offered in as many Terms as it runs in. Where a School Administrator keeps
 * the catalogue, narrowed to the Course being looked for.
 *
 * The session names this page to a School Administrator only (ADR-0007), and
 * the server refuses anyone else with the one "not available" state.
 */
export function Courses({ school }: { school: ReachedSchool }) {
  const { schoolId } = school;
  const { showing, busy, change } = useScreen(schoolId, list);

  switch (showing.kind) {
    case "loading":
      return <Sheet {...SHEET} busy />;
    case "not-available":
      return <NotAvailable />;
    case "ready":
      return (
        <CoursesSheet
          schoolId={schoolId}
          courses={showing.records.courses}
          offered={showing.records.offered}
          busy={busy}
          onCreate={(course) => change(() => api.createCourse(schoolId, course))}
          onChange={(course, proposed) => change(() => api.changeCourse(schoolId, course.id, proposed))}
          onDelete={(course) => change(() => api.deleteCourse(schoolId, course.id))}
        />
      );
  }
}

function CoursesSheet({
  schoolId,
  courses,
  offered,
  busy,
  onCreate,
  onChange,
  onDelete,
}: {
  schoolId: string;
  courses: Course[];
  offered: ReadonlyMap<string, number>;
  busy: boolean;
  onCreate: (course: Proposed) => Promise<ApiResult<unknown>>;
  onChange: (course: Course, proposed: Proposed) => Promise<ApiResult<unknown>>;
  onDelete: (course: Course) => Promise<ApiResult<unknown>>;
}) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Course | null>(null);
  const [deleting, setDeleting] = useState<Course | null>(null);
  /** A Course whose editor or dialog just closed, so its Change control takes the focus back. */
  const [returning, setReturning] = useState<string | null>(null);
  /** Why the last creation or deletion changed nothing. */
  const [problem, setProblem] = useState<{ about: "create" | "delete"; message: string } | null>(null);
  /** What the last change did, said once so a screen reader hears it land. */
  const [done, setDone] = useState("");

  const looking = query.trim();
  const shown = looking === "" ? courses : courses.filter((course) => matches(course, looking));
  const classOfferings = <Link to={{ name: "classOfferings", schoolId }}>Class Offerings</Link>;

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const course = proposedFrom(new FormData(form));
    setProblem(null);
    setDone("");
    const sent = await onCreate(course);
    if (sent.ok) {
      form.reset();
      setDone(`${course.name} is created. Offer it in a Term on Class Offerings.`);
    } else if (sent.conflict !== undefined) {
      setProblem({ about: "create", message: conflictMessage(sent.conflict) });
    }
  };

  const legend = (
    <>
      <h2>Key</h2>
      <p>The subjects this School teaches.</p>
      <dl>
        <Key term="Course">
          A subject defined once and offered in as many Terms as it runs in. No two Courses share a name, however it is
          capitalised.
        </Key>
        <Key term="Code">An optional short name, such as MATH-101. No two Courses share one either.</Key>
        <Key term="Offerings">
          How many Class Offerings offer the Course. A Course is not deleted while it has any.
        </Key>
      </dl>
    </>
  );

  return (
    <Sheet {...SHEET} legend={legend}>
      <h1>Courses</h1>
      {courses.length > 0 && (
        <search className="filter">
          <label>
            Find by name or code
            <input
              type="search"
              name="find"
              value={query}
              autoComplete="off"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
        </search>
      )}
      <p className="muted" role="status">
        {done === "" && courses.length > 0 ? tally(shown.length, courses.length, looking) : done}
      </p>

      <RecordList
        label="Courses"
        rows={shown}
        keyOf={(course) => course.id}
        empty={
          courses.length === 0
            ? "This School has no Course yet. Define the first one below, then offer it in a Term."
            : `No Course's name or code contains “${looking}”.`
        }
        columns={[
          { head: "Course", cell: (course) => <CourseName course={course}>{course.name}</CourseName> },
          {
            head: "Code",
            cell: (course) => (course.code === null ? <span className="muted">None</span> : <code>{course.code}</code>),
          },
          { head: "Offerings", cell: (course) => offered.get(course.id) ?? 0 },
          {
            head: "Change or delete",
            actions: true,
            cell: (course) => (
              <span className="actions record__buttons">
                <ReturningButton
                  focus={returning === course.id}
                  disabled={busy || editing !== null}
                  label={`Change ${course.name}`}
                  onClick={() => {
                    setProblem(null);
                    setDone("");
                    setReturning(null);
                    setEditing(course);
                  }}
                >
                  Change
                </ReturningButton>
                <button
                  type="button"
                  className="button-stamp"
                  disabled={busy || editing !== null}
                  aria-label={`Delete ${course.name}`}
                  onClick={() => {
                    setProblem(null);
                    setDone("");
                    setReturning(null);
                    setDeleting(course);
                  }}
                >
                  Delete
                </button>
              </span>
            ),
          },
        ]}
      />
      {problem?.about === "delete" && (
        <p role="alert" className="error">
          {problem.message}
        </p>
      )}

      {editing !== null && (
        <CourseEditor
          key={editing.id}
          course={editing}
          busy={busy}
          onCancel={() => {
            setEditing(null);
            setReturning(editing.id);
          }}
          onSave={async (proposed) => {
            const sent = await onChange(editing, proposed);
            if (sent.ok) {
              setEditing(null);
              setReturning(editing.id);
              setDone(`${proposed.name} is saved.`);
            }
            return sent;
          }}
        />
      )}

      <form onSubmit={create} aria-label="Define a Course">
        <h2>Define a Course</h2>
        <CourseFields />
        <p className="muted">Once it exists, offer it in a Term on {classOfferings}.</p>
        {problem?.about === "create" && (
          <p role="alert" className="error">
            {problem.message}
          </p>
        )}
        <button type="submit" disabled={busy || editing !== null}>
          Create Course
        </button>
      </form>

      {deleting !== null && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          confirm="Delete the Course"
          busy={busy}
          // The dialog hands the focus back to the Delete control that opened it.
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            const course = deleting;
            setDeleting(null);
            const sent = await onDelete(course);
            if (sent.ok) {
              setDone(`${course.name} is deleted.`);
            } else if (sent.conflict !== undefined) {
              setReturning(course.id);
              setProblem({ about: "delete", message: conflictMessage(sent.conflict) });
            }
          }}
        >
          {(offered.get(deleting.id) ?? 0) > 0 ? (
            <p>
              {deleting.name} is offered in {offeringCount(offered.get(deleting.id)!)}. A Course is not deleted while it
              is offered: delete its Class Offerings first.
            </p>
          ) : (
            <p>{deleting.name} is removed from the catalogue. It is not offered in any Term.</p>
          )}
        </ConfirmDialog>
      )}
    </Sheet>
  );
}

/** A Course's name and code, changed in place and saved as one change. */
function CourseEditor({
  course,
  busy,
  onCancel,
  onSave,
}: {
  course: Course;
  busy: boolean;
  onCancel: () => void;
  onSave: (proposed: Proposed) => Promise<ApiResult<unknown>>;
}) {
  const [problem, setProblem] = useState<string | null>(null);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setProblem(null);
    const sent = await onSave(proposedFrom(new FormData(event.currentTarget)));
    if (!sent.ok && sent.conflict !== undefined) {
      setProblem(conflictMessage(sent.conflict));
    }
  };

  return (
    <form onSubmit={save} aria-label={`Change ${course.name}`}>
      <h2>Change {course.name}</h2>
      {/* The editor opens below the list, so the focus goes to its first field. */}
      <CourseFields course={course} autoFocus />
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

/** A Course's name and optional code, as it is defined or changed. */
function CourseFields({ course, autoFocus = false }: { course?: Course; autoFocus?: boolean }) {
  return (
    <>
      <label>
        Name
        <input
          name="name"
          required
          maxLength={MAX_NAME_LENGTH}
          autoComplete="off"
          autoFocus={autoFocus}
          defaultValue={course?.name}
          placeholder={course === undefined ? "Algebra I" : undefined}
        />
      </label>
      <label>
        Code (optional)
        <input
          name="code"
          maxLength={MAX_NAME_LENGTH}
          autoComplete="off"
          defaultValue={course?.code ?? undefined}
          placeholder={course === undefined ? "MATH-101" : undefined}
        />
      </label>
    </>
  );
}

/** A quiet control that takes the focus back when the editor or dialog it opened closes. */
function ReturningButton({
  focus,
  disabled,
  label,
  onClick,
  children,
}: {
  focus: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
  children: string;
}) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focus && !disabled) {
      button.current?.focus();
    }
  }, [focus, disabled]);
  return (
    <button ref={button} type="button" className="button-quiet" disabled={disabled} aria-label={label} onClick={onClick}>
      {children}
    </button>
  );
}

/** A Course as a form states it: a code left blank is none. */
function proposedFrom(fields: FormData): Proposed {
  const code = String(fields.get("code") ?? "").trim();
  return { name: String(fields.get("name") ?? ""), code: code === "" ? null : code };
}

/** Whether a Course is the one being looked for, by any part of its name or code. */
function matches(course: Course, looking: string): boolean {
  const sought = looking.toLocaleLowerCase();
  return [course.name, course.code ?? ""].some((text) => text.toLocaleLowerCase().includes(sought));
}

/** How much of the catalogue is in front of you, said so a screen reader hears it change. */
function tally(shown: number, total: number, looking: string): string {
  const courses = `${total} ${total === 1 ? "Course" : "Courses"}`;
  return looking === "" ? courses : `${shown} of ${courses} shown`;
}

function offeringCount(count: number): string {
  return count === 1 ? "1 Class Offering" : `${count} Class Offerings`;
}

/** Why a change to the catalogue changed nothing, in the words of the rule it would have broken. */
function conflictMessage(conflict: ConflictDetail): string {
  switch (conflict.conflict) {
    case "course_name_taken":
      return "Another Course already has that name, however it is capitalised. Give this one a name that tells them apart.";
    case "course_code_taken":
      return "Another Course already has that code, however it is capitalised. Give this one another code, or none.";
    case "dependent":
      return "This Course is offered in a Term, and a Course is not deleted while it is offered. Delete its Class Offerings first.";
    default:
      return "That change could not be made.";
  }
}
