import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AttendanceStatus } from "./api.ts";
import { STATUS_NAMES, STATUSES } from "./attendance.ts";

/**
 * A Trial School in miniature, beside the landing page's headline: one
 * Class Offering's Attendance, one Guardian's Term report and the Audit
 * trail, each seen as the role that sees it. Everything in it is invented
 * and lives only in this page; nothing is sent anywhere.
 *
 * It keeps the app's own rules, so what it shows is true of the app: a first
 * mark names its own recorder and is not audited, a changed one is; saving
 * marks every unmarked Student Present; a Guardian sees what their Access
 * profile grants, with nothing marking what is withheld.
 */

type Role = "faculty" | "guardian" | "school_administrator";

const ROLES: { role: Role; name: string }[] = [
  { role: "faculty", name: "Faculty" },
  { role: "guardian", name: "Guardian" },
  { role: "school_administrator", name: "School Administrator" },
];

/** The invented Trial School's people, as its seed names them. */
const FACULTY = "Sam Achterberg";
const SCHOOL_ADMINISTRATOR = "Morgan Reyes";
const GUARDIAN = "Alex Lindqvist";
const STUDENT = "Jamie Lindqvist";
const ROSTER = [STUDENT, "Quinn Adebayo", "Riley Fernsby", "Taylor Nakamura"];

type Marks = Record<string, AttendanceStatus | null>;

const UNMARKED: Marks = Object.fromEntries(ROSTER.map((student) => [student, null]));

/** Jamie's Term so far, before today's mark is saved. */
const TERM_REPORT = [
  { offering: "Mathematics", result: "B", present: 38, tardy: 1, excused: 2, unexcused: 0, today: true },
  { offering: "English Literature", result: "A−", present: 40, tardy: 0, excused: 1, unexcused: 0, today: false },
];

interface AuditEntry {
  id: number;
  actor: string;
  what: string;
  at: Date;
  fresh: boolean;
}

interface Access {
  attendance: boolean;
  results: boolean;
}

export function MiniatureSchool() {
  const id = useId();
  const [role, setRole] = useState<Role>("faculty");
  const [marks, setMarks] = useState<Marks>(UNMARKED);
  const [saved, setSaved] = useState<Marks>(UNMARKED);
  const [said, setSaid] = useState("");
  const [access, setAccess] = useState<Access>({ attendance: true, results: true });
  const [audit, setAudit] = useState<AuditEntry[]>(() => {
    const now = Date.now();
    return [
      { id: 2, actor: FACULTY, what: "signed in", at: new Date(now - 4 * 60_000), fresh: false },
      { id: 1, actor: GUARDIAN, what: "signed in", at: new Date(now - 11 * 60_000), fresh: false },
    ];
  });
  const [unseen, setUnseen] = useState(0);
  const nextAudit = useRef(3);
  const tabs = useRef<Record<Role, HTMLButtonElement | null>>({ faculty: null, guardian: null, school_administrator: null });
  const seal = useRef<HTMLSpanElement>(null);
  const sealWas = useRef<DOMRect | null>(null);

  // The seal slides from the role left to the one chosen: drawn in its new
  // place, then played from where it was (FLIP), so the words stay on top.
  useLayoutEffect(() => {
    const element = seal.current;
    if (element === null) return;
    const was = sealWas.current;
    const now = element.getBoundingClientRect();
    sealWas.current = now;
    if (was === null || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    element.animate(
      [
        {
          transform: `translateX(${was.left - now.left}px) scaleX(${was.width / now.width})`,
          transformOrigin: "left center",
        },
        { transform: "none", transformOrigin: "left center" },
      ],
      { duration: 240, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
  }, [role]);

  const record = (actor: string, whats: string[]) => {
    if (whats.length === 0) return;
    const at = new Date();
    setAudit((entries) => [
      ...whats.map((what) => ({ id: nextAudit.current++, actor, what, at, fresh: true })).reverse(),
      ...entries.map((entry) => ({ ...entry, fresh: false })),
    ]);
    if (role !== "school_administrator") setUnseen((count) => count + whats.length);
  };

  const view = (next: Role) => {
    if (next === role) return;
    setRole(next);
    if (next === "school_administrator") setUnseen(0);
  };

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const at = ROLES.findIndex((entry) => entry.role === role);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: ROLES.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const next = ROLES[(to + ROLES.length) % ROLES.length]!.role;
    view(next);
    tabs.current[next]?.focus();
  };

  const dirty = ROSTER.some((student) => marks[student] !== saved[student]);

  const save = () => {
    const after: Marks = Object.fromEntries(ROSTER.map((student) => [student, marks[student] ?? "present"]));
    const changes = ROSTER.filter((student) => saved[student] !== null && saved[student] !== after[student]).map(
      (student) => `changed ${student}'s Attendance from ${STATUS_NAMES[saved[student]!]} to ${STATUS_NAMES[after[student]!]}`,
    );
    const firstSave = ROSTER.some((student) => saved[student] === null);
    setMarks(after);
    setSaved(after);
    record(FACULTY, changes);
    setSaid(
      changes.length > 0
        ? `Saved. ${changes.length === 1 ? "The change is" : `${changes.length} changes are`} on the Audit trail.`
        : firstSave
          ? "Saved, and every unmarked Student is marked Present. Change a mark and save again."
          : "Saved.",
    );
  };

  const grant = (key: keyof Access, on: boolean) => {
    const next = { ...access, [key]: on };
    setAccess(next);
    const granted = [next.attendance && "Attendance", next.results && "Term results"].filter(Boolean).join(" and ");
    record(SCHOOL_ADMINISTRATOR, [
      `changed ${GUARDIAN}'s Access profile for ${STUDENT} to ${granted === "" ? "nothing" : granted}`,
    ]);
  };

  return (
    <div className="mini" role="group" aria-label="Riverbend School, a Trial School in miniature">
      <div className="mini__head">
        <span className="mini__badge" aria-hidden="true">
          RS
        </span>
        <span className="mini__school">Riverbend School</span>
        <span className="mini__invented">Invented data, kept in this page only</span>
      </div>

      <div className="mini__roles" role="tablist" aria-label="Viewing as">
        {ROLES.map(({ role: tab, name }) => {
          const selected = tab === role;
          const count = tab === "school_administrator" ? unseen : 0;
          return (
            <button
              key={tab}
              ref={(element) => {
                tabs.current[tab] = element;
              }}
              type="button"
              role="tab"
              id={`${id}-${tab}`}
              aria-selected={selected}
              aria-controls={`${id}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => view(tab)}
              onKeyDown={onTabKey}
            >
              {selected && <span ref={seal} className="mini__seal" aria-hidden="true" />}
              <span className="mini__role">{name}</span>{" "}
              {count > 0 && (
                <span key={count} className="mini__count">
                  {count}
                  <span className="visually-hidden"> new</span>
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div key={role} className="mini__panel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${role}`} tabIndex={0}>
        {role === "faculty" && (
          <>
            <p className="mini__context">
              <span className="mini__chip" aria-hidden="true" />
              Mathematics, today&apos;s Attendance session
            </p>
            <ul className="mini__roster">
              {ROSTER.map((student) => (
                <li key={student} className={marks[student] === null ? "mini__row" : "mini__row mini__row--marked"}>
                  <span className="mini__disc" aria-hidden="true" />
                  <label htmlFor={`${id}-${student}`}>{student}</label>
                  <select
                    id={`${id}-${student}`}
                    value={marks[student] ?? ""}
                    onChange={(event) => {
                      setSaid("");
                      setMarks({ ...marks, [student]: event.target.value as AttendanceStatus });
                    }}
                  >
                    <option value="" disabled>
                      Unmarked
                    </option>
                    {STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {STATUS_NAMES[status]}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
            <div className="mini__actions">
              <button
                type="button"
                className="button-ghost"
                disabled={ROSTER.every((student) => marks[student] === "present")}
                onClick={() => {
                  setSaid("");
                  setMarks(Object.fromEntries(ROSTER.map((student) => [student, "present"])));
                }}
              >
                Mark all Present
              </button>
              <button type="button" disabled={!dirty} onClick={save}>
                Save
              </button>
            </div>
          </>
        )}

        {role === "guardian" && (
          <>
            <p className="mini__context">
              {GUARDIAN}, reading {STUDENT}&apos;s Term report
            </p>
            <fieldset className="mini__access">
              <legend>Access profile, set by a School Administrator</legend>
              <label className="check">
                <input
                  type="checkbox"
                  checked={access.attendance}
                  onChange={(event) => grant("attendance", event.target.checked)}
                />
                Attendance
              </label>
              <label className="check">
                <input type="checkbox" checked={access.results} onChange={(event) => grant("results", event.target.checked)} />
                Term results
              </label>
            </fieldset>
            <ul className="mini__report">
              {TERM_REPORT.map((row) => {
                const today = row.today ? saved[STUDENT] : null;
                return (
                  <li key={row.offering}>
                    <span className="mini__offering">{row.offering}</span>
                    {access.results && <Fact term="Term result">{row.result}</Fact>}
                    {access.attendance && (
                      <>
                        <Fact term="Present">{row.present + (today === "present" ? 1 : 0)}</Fact>
                        <Fact term="Tardy">{row.tardy + (today === "tardy" ? 1 : 0)}</Fact>
                        <Fact term="Excused absence">{row.excused + (today === "excused_absence" ? 1 : 0)}</Fact>
                        <Fact term="Unexcused absence">{row.unexcused + (today === "unexcused_absence" ? 1 : 0)}</Fact>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {role === "school_administrator" && (
          <>
            <p className="mini__context">{SCHOOL_ADMINISTRATOR}, reading the Audit trail, newest first</p>
            <ol className="mini__audit">
              {audit.slice(0, 5).map((entry) => (
                <li key={entry.id} className={entry.fresh ? "mini__entry mini__entry--fresh" : "mini__entry"}>
                  <time dateTime={entry.at.toISOString()}>
                    {entry.at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  </time>
                  <span>
                    <strong>{entry.actor}</strong> {entry.what}
                  </span>
                </li>
              ))}
            </ol>
            <p className="mini__hint">Change a saved mark as Faculty, or an Access profile, and it arrives here.</p>
          </>
        )}

        <p className="mini__said" role="status">
          {role === "faculty" ? said : ""}
        </p>
      </div>
    </div>
  );
}

/** One figure in a Term report entry: its name, then its value. */
function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <span className="mini__fact">
      <span>{term}</span> <strong>{children}</strong>
    </span>
  );
}
