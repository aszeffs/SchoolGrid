import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Weekday } from "../../src/calendar/index.ts";
import type {
  AcademicYear,
  ApiResult,
  ConflictDetail,
  InstructionalDayException,
  ProposedException,
} from "./api.ts";

/**
 * An Academic Year's Instructional days: its weekday pattern, and a calendar
 * of the year a month at a time, where a single day is taken out as a holiday
 * or put in as a make-up day.
 *
 * Which days are Instructional days is the server's to say, and it lists them
 * in the year it sends. Nothing here works that out from the pattern: a day is
 * shown as one only because the server listed it.
 *
 * The calendar is worked as a grid (the WAI-ARIA grid pattern): one of its days
 * is in the Tab order, the arrow keys move between days, Home and End to the
 * ends of a week, and Page Up and Page Down a month. Choosing a day says what
 * it is and offers the one change it can take, so no single press changes the
 * School's calendar.
 *
 * What each change did is said through `say`, into the sheet's one status
 * region, so a screen reader hears it land wherever the focus is.
 */
export function InstructionalDays({
  year,
  busy,
  say,
  onSetPattern,
  onAddException,
  onRemoveException,
}: {
  year: AcademicYear;
  busy: boolean;
  say: (message: string) => void;
  onSetPattern: (weekdays: Weekday[]) => Promise<ApiResult<unknown>>;
  onAddException: (exception: ProposedException) => Promise<ApiResult<unknown>>;
  onRemoveException: (exception: InstructionalDayException) => Promise<ApiResult<unknown>>;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="instructional-days">
      <h3 id={headingId}>Instructional days</h3>
      <WeekdayPattern year={year} busy={busy} say={say} onSetPattern={onSetPattern} />
      <MonthCalendar
        year={year}
        busy={busy}
        say={say}
        onAddException={onAddException}
        onRemoveException={onRemoveException}
      />
    </section>
  );
}

/**
 * Each weekday's name, Monday first. A record rather than a list, so a day the
 * service knows cannot be missing here; the list is taken from it rather than
 * imported, since the page's build takes nothing of the service's at run time
 * but its bounds (Dockerfile).
 */
const WEEKDAY_NAMES: Record<Weekday, string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

const WEEKDAYS = Object.keys(WEEKDAY_NAMES) as Weekday[];

/** The weekdays that are Instructional days unless a day is taken out or put in. */
function WeekdayPattern({
  year,
  busy,
  say,
  onSetPattern,
}: {
  year: AcademicYear;
  busy: boolean;
  say: (message: string) => void;
  onSetPattern: (weekdays: Weekday[]) => Promise<ApiResult<unknown>>;
}) {
  const [chosen, setChosen] = useState<Weekday[]>(year.weekdays);
  const held = year.weekdays.join();
  // The pattern the server holds is what the boxes show once it changes.
  useEffect(() => setChosen(year.weekdays), [held]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Held rather than disabled while a change is in flight, so the focus stays on the button.
    if (busy) {
      return;
    }
    say("");
    const sent = await onSetPattern(chosen);
    if (sent.ok) {
      say(`The weekday pattern of ${year.name} is saved.`);
    }
  };

  return (
    <form onSubmit={save} aria-label={`Weekday pattern of ${year.name}`} className="pattern">
      <fieldset>
        <legend>Weekday pattern</legend>
        <p className="muted">Each day ticked is an Instructional day, unless it is taken out in the calendar.</p>
        <div className="pattern__days">
          {WEEKDAYS.map((day) => (
            <label key={day} className="check">
              <input
                type="checkbox"
                checked={chosen.includes(day)}
                onChange={(event) => {
                  const on = event.currentTarget.checked;
                  setChosen((days) => WEEKDAYS.filter((each) => (each === day ? on : days.includes(each))));
                }}
              />
              {WEEKDAY_NAMES[day]}
            </label>
          ))}
        </div>
      </fieldset>
      <button type="submit" className="button-ghost" aria-disabled={busy}>
        Save the pattern
      </button>
    </form>
  );
}

/** What one day of the year is, as the server's lists make it. */
type DayState = "instructional" | "not-instructional" | "holiday" | "make-up";

/** What each state is called on a day's button, how a chosen day is described, and the change it offers. */
const STATES: Record<DayState, { words: string; is: string; action: string }> = {
  instructional: {
    words: "Instructional day",
    is: "is an Instructional day by the weekday pattern.",
    action: "Take it out as a holiday",
  },
  "not-instructional": {
    words: "not an Instructional day",
    is: "is not an Instructional day by the weekday pattern.",
    action: "Put it in as a make-up day",
  },
  holiday: { words: "holiday, taken out", is: "is taken out as a holiday.", action: "Return it to the weekday pattern" },
  "make-up": {
    words: "make-up day, put in",
    is: "is put in as a make-up day.",
    action: "Return it to the weekday pattern",
  },
};

/** A day as a reader expects it in full. The date is read at midnight UTC, where it was made. */
const FULL_DAY = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeZone: "UTC" });
const MONTH = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
const SHORT_WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" });

/**
 * The year a month at a time. Each day of the year is a button naming the day
 * and what it is; the days of a month outside the year are left blank.
 */
function MonthCalendar({
  year,
  busy,
  say,
  onAddException,
  onRemoveException,
}: {
  year: AcademicYear;
  busy: boolean;
  say: (message: string) => void;
  onAddException: (exception: ProposedException) => Promise<ApiResult<unknown>>;
  onRemoveException: (exception: InstructionalDayException) => Promise<ApiResult<unknown>>;
}) {
  const headingId = useId();
  const [month, setMonth] = useState(() => monthOf(year.firstDate));
  /** The day last moved to, which holds the grid's place in the Tab order while it is shown. */
  const [current, setCurrent] = useState(year.firstDate);
  const [chosen, setChosen] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** Whether the last move was made within the grid, so the focus follows it there. */
  const moved = useRef(false);
  const grid = useRef<HTMLTableElement>(null);

  const inYear = (date: string) => year.firstDate <= date && date <= year.lastDate;
  const instructional = new Set(year.instructionalDays);
  const exceptions = new Map(year.exceptions.map((exception) => [exception.date, exception]));
  const stateOf = (date: string): DayState => {
    const exception = exceptions.get(date);
    if (exception !== undefined) {
      return exception.instructional ? "make-up" : "holiday";
    }
    return instructional.has(date) ? "instructional" : "not-instructional";
  };

  // The year's bounds may have moved since a day or month was chosen.
  const firstMonth = monthOf(year.firstDate);
  const lastMonth = monthOf(year.lastDate);
  const shown = clamp(month, firstMonth, lastMonth);
  const days = daysOfMonth(shown);
  const tabStop = inYear(current) && monthOf(current) === shown ? current : days.find(inYear)!;
  const picked = chosen !== null && inYear(chosen) ? chosen : null;

  useEffect(() => {
    if (moved.current) {
      moved.current = false;
      grid.current?.querySelector<HTMLButtonElement>(`button[data-date="${tabStop}"]`)?.focus();
    }
  }, [tabStop]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, date: string) => {
    const weekday = isoWeekday(date);
    const moves: Record<string, () => string> = {
      ArrowLeft: () => addDays(date, -1),
      ArrowRight: () => addDays(date, 1),
      ArrowUp: () => addDays(date, -7),
      ArrowDown: () => addDays(date, 7),
      Home: () => addDays(date, 1 - weekday),
      End: () => addDays(date, 7 - weekday),
      PageUp: () => addMonths(date, -1),
      PageDown: () => addMonths(date, 1),
    };
    const move = moves[event.key];
    if (move === undefined) {
      return;
    }
    event.preventDefault();
    const to = clamp(move(), year.firstDate, year.lastDate);
    if (to !== date) {
      moved.current = true;
      setCurrent(to);
      setMonth(monthOf(to));
    }
  };

  const turn = (by: number) => {
    const next = monthOf(addMonths(`${shown}-01`, by));
    if (next < firstMonth || next > lastMonth) {
      return;
    }
    setMonth(next);
    setCurrent(daysOfMonth(next).find(inYear)!);
  };

  const change = async () => {
    if (busy || picked === null) {
      return;
    }
    setProblem(null);
    say("");
    const day = FULL_DAY.format(utc(picked));
    const exception = exceptions.get(picked);
    const putIn = stateOf(picked) === "not-instructional";
    const sent =
      exception !== undefined
        ? await onRemoveException(exception)
        : await onAddException({ date: picked, instructional: putIn });
    if (sent.ok) {
      say(
        exception !== undefined
          ? `${day} is returned to the weekday pattern.`
          : putIn
            ? `${day} is put in as a make-up day.`
            : `${day} is taken out as a holiday.`,
      );
    } else if (sent.conflict !== undefined) {
      setProblem(conflictMessage(sent.conflict));
    }
  };

  const weeks = weeksOf(days);

  return (
    <div className="calendar">
      <div className="calendar__head">
        <h4 id={headingId}>{MONTH.format(utc(`${shown}-01`))}</h4>
        <p className="calendar__count">{dayCount(days.filter((date) => instructional.has(date)).length)}</p>
        <p className="actions">
          <button
            type="button"
            className="button-quiet"
            aria-disabled={shown === firstMonth}
            aria-label={`Previous month of ${year.name}`}
            onClick={() => turn(-1)}
          >
            Previous
          </button>
          <button
            type="button"
            className="button-quiet"
            aria-disabled={shown === lastMonth}
            aria-label={`Next month of ${year.name}`}
            onClick={() => turn(1)}
          >
            Next
          </button>
        </p>
      </div>
      <table role="grid" ref={grid} aria-labelledby={headingId} className="calendar__grid">
        <thead>
          <tr>
            {weeks[0]!.map((date) => (
              <th key={date} scope="col">
                <abbr title={WEEKDAY_NAMES[WEEKDAYS[isoWeekday(date) - 1]!]}>{SHORT_WEEKDAY.format(utc(date))}</abbr>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((date) => {
                if (monthOf(date) !== shown || !inYear(date)) {
                  return <td key={date} />;
                }
                const state = stateOf(date);
                return (
                  <td key={date} aria-selected={picked === date}>
                    <button
                      type="button"
                      data-date={date}
                      className={`day day--${state}`}
                      tabIndex={date === tabStop ? 0 : -1}
                      aria-label={`${FULL_DAY.format(utc(date))}: ${STATES[state].words}`}
                      onKeyDown={(event) => onKeyDown(event, date)}
                      onClick={() => {
                        setCurrent(date);
                        setChosen(date);
                        setProblem(null);
                      }}
                    >
                      <span aria-hidden="true">{Number(date.slice(8))}</span>
                      <span className="day__mark" aria-hidden="true" />
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="calendar__chosen">
        <p>{picked === null
            ? "Choose a day to take it out or put it in."
            : `${FULL_DAY.format(utc(picked))} ${STATES[stateOf(picked)].is}`}</p>
        {problem !== null && (
          <p role="alert" className="error">
            {problem}
          </p>
        )}
        {picked !== null && (
          <button type="button" className="button-ghost" aria-disabled={busy} onClick={change}>
            {STATES[stateOf(picked)].action}
          </button>
        )}
      </div>
    </div>
  );
}

/** Why a day's change changed nothing. The calendar offers only days of the year, one change each. */
function conflictMessage(conflict: ConflictDetail): string {
  return conflict.conflict === "exception_date_taken"
    ? "That day was taken out or put in a moment ago, elsewhere. It is shown as it now stands."
    : "That day is no longer in the year. The calendar shows the year as it now stands.";
}

export function dayCount(count: number): string {
  return count === 1 ? "1 Instructional day" : `${count} Instructional days`;
}

// A School date is a day with no time and no timezone. It is worked on as
// midnight UTC, where no clock change can move it.

function utc(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function monthOf(date: string): string {
  return date.slice(0, 7);
}

function addDays(date: string, days: number): string {
  const moment = utc(date);
  moment.setUTCDate(moment.getUTCDate() + days);
  return moment.toISOString().slice(0, 10);
}

/** The same day of another month, or that month's last day when it is shorter. */
function addMonths(date: string, months: number): string {
  const first = utc(`${monthOf(date)}-01`);
  first.setUTCMonth(first.getUTCMonth() + months);
  const length = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(Number(date.slice(8)), length));
  return first.toISOString().slice(0, 10);
}

/** 1 for Monday to 7 for Sunday. */
function isoWeekday(date: string): number {
  return ((utc(date).getUTCDay() + 6) % 7) + 1;
}

/** `YYYY-MM-DD` and `YYYY-MM` both sort as what they name does. */
function clamp(value: string, first: string, last: string): string {
  return value < first ? first : value > last ? last : value;
}

function daysOfMonth(month: string): string[] {
  const days: string[] = [];
  for (let date = `${month}-01`; monthOf(date) === month; date = addDays(date, 1)) {
    days.push(date);
  }
  return days;
}

/** A month's days in weeks from Monday, filled out at either end with the neighbouring months' days. */
function weeksOf(days: string[]): string[][] {
  const start = addDays(days[0]!, 1 - isoWeekday(days[0]!));
  const end = addDays(days.at(-1)!, 7 - isoWeekday(days.at(-1)!));
  const weeks: string[][] = [];
  for (let monday = start; monday <= end; monday = addDays(monday, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, index) => addDays(monday, index)));
  }
  return weeks;
}
