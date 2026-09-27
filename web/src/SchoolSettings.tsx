import { useState, type FormEvent } from "react";
import { MAX_ATTENDANCE_WINDOW } from "../../src/validation/bounds.ts";
import { api, type AttendanceWindowChange, type ReachedSchool, type SchoolSettings as Settings } from "./api.ts";
import { ConfirmDialog } from "./Dialog.tsx";
import { Link } from "./Link.tsx";
import { NotAvailable } from "./NotAvailable.tsx";
import { useScreen } from "./screen.ts";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";

/** Which sheet this page is, named once so its states cannot drift apart. */
const SHEET: SheetKind = { name: "School settings" };

/** A window change waiting on its confirmation, with what the server says it would open or close. */
interface ProposedWindowChange {
  attendanceWindow: number;
  change: AttendanceWindowChange;
}

/**
 * What a School Administrator configures about their School: its timezone,
 * where each of the School's days begins and ends, and its Attendance window,
 * how long after a School date its Attendance can still be recorded normally.
 *
 * The session names this page to a School Administrator only (ADR-0007), and
 * the server refuses anyone else with the one "not available" state.
 */
export function SchoolSettings({ school }: { school: ReachedSchool }) {
  const { schoolId } = school;
  const { showing, busy, change } = useScreen(schoolId, api.schoolSettings);
  /** What the last change did, said once so a screen reader hears it land. */
  const [changed, setChanged] = useState<string | null>(null);
  const [proposed, setProposed] = useState<ProposedWindowChange | null>(null);

  const setTimezone = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const timezone = String(new FormData(event.currentTarget).get("timezone") ?? "");
    setChanged(null);
    const sent = await change(() => api.setTimezone(schoolId, timezone));
    if (sent.ok) {
      setChanged(`The School now keeps its days in ${sent.body.settings.timezone}.`);
    }
  };

  // Asks what the change would open or close before anything is sent, so the
  // confirmation can say so.
  const proposeAttendanceWindow = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const attendanceWindow = Number(new FormData(event.currentTarget).get("attendanceWindow"));
    setChanged(null);
    // Stating the window the School already has would change nothing.
    if (showing.kind === "ready" && attendanceWindow === showing.records.settings.attendanceWindow) {
      setChanged(`The Attendance window is already ${daysPhrase(attendanceWindow)}.`);
      return;
    }
    const previewed = await api.previewAttendanceWindow(schoolId, attendanceWindow);
    if (previewed.ok) {
      setProposed({ attendanceWindow, change: previewed.body });
    } else {
      setChanged("That change is not available.");
    }
  };

  const setAttendanceWindow = async (attendanceWindow: number) => {
    const sent = await change(() => api.setAttendanceWindow(schoolId, attendanceWindow));
    setProposed(null);
    if (sent.ok) {
      setChanged(`Attendance can now be recorded ${windowPhrase(sent.body.settings.attendanceWindow)}.`);
    }
  };

  switch (showing.kind) {
    case "loading":
      return <Sheet {...SHEET} busy />;
    case "not-available":
      return <NotAvailable />;
    case "ready":
      return (
        <>
          <SettingsSheet
            schoolId={schoolId}
            settings={showing.records.settings}
            timezones={showing.records.timezones}
            busy={busy}
            changed={changed}
            onSetTimezone={setTimezone}
            onProposeAttendanceWindow={proposeAttendanceWindow}
          />
          {proposed !== null && (
            <ConfirmDialog
              title="Change the Attendance window?"
              confirm="Change the window"
              busy={busy}
              onCancel={() => setProposed(null)}
              onConfirm={() => void setAttendanceWindow(proposed.attendanceWindow)}
            >
              <p>
                Attendance will be recorded and corrected normally {windowPhrase(proposed.attendanceWindow)}, instead
                of {windowPhrase(showing.records.settings.attendanceWindow)}. The change applies to every School date
                at once.
              </p>
              <p className="notice">{changePhrase(proposed.change)}</p>
            </ConfirmDialog>
          )}
        </>
      );
  }
}

/** A count of days as a reader says it: "1 day", "7 days", "4 past Instructional days". */
function daysPhrase(count: number, kind = ""): string {
  return `${count} ${kind}${count === 1 ? "day" : "days"}`;
}

/** A window as a sentence says it: "on its School date only", "up to 7 days after its School date". */
function windowPhrase(days: number): string {
  return days === 0 ? "on its School date only" : `up to ${daysPhrase(days)} after its School date`;
}

/** What a window change does to the School dates already past, counted in Instructional days. */
function changePhrase({ opens, closes }: AttendanceWindowChange): string {
  const past = "past Instructional ";
  if (opens > 0) {
    return `This opens ${daysPhrase(opens, past)} to normal corrections again.`;
  }
  if (closes > 0) {
    return `This closes ${daysPhrase(closes, past)}. Correcting their Attendance will then take a Correction request.`;
  }
  return "No past Instructional day opens or closes.";
}

function SettingsSheet({
  schoolId,
  settings,
  timezones,
  busy,
  changed,
  onSetTimezone,
  onProposeAttendanceWindow,
}: {
  schoolId: string;
  settings: Settings;
  timezones: string[];
  busy: boolean;
  changed: string | null;
  onSetTimezone: (event: FormEvent<HTMLFormElement>) => void;
  onProposeAttendanceWindow: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const legend = (
    <>
      <h2>Key</h2>
      <p>How this School keeps its calendar.</p>
      <dl>
        <Key term="Timezone">
          Where each School date begins and ends. A day is recorded as the School saw it, whatever the time where you
          are.
        </Key>
        <Key term="Academic Year">
          Once the School&rsquo;s first Academic Year exists, the timezone is fixed, so no date already recorded can
          move to another day.
        </Key>
        <Key term="Attendance window">
          How many days after a School date Faculty can still record or correct its Attendance. After that, a
          correction takes a Correction request.
        </Key>
      </dl>
    </>
  );

  return (
    <Sheet {...SHEET} legend={legend}>
      <h1>School settings</h1>
      <dl className="facts">
        <dt>Timezone</dt>
        <dd>{settings.timezone}</dd>
        <dt>Attendance window</dt>
        <dd>
          {settings.attendanceWindow === 0 ? "Same day only" : daysPhrase(settings.attendanceWindow)}
        </dd>
      </dl>
      <p className="muted" role="status">
        {changed ?? ""}
      </p>

      {settings.timezoneFixed ? (
        <section aria-labelledby="timezone-fixed">
          <h2 id="timezone-fixed">The timezone is fixed</h2>
          <p className="notice">
            This School has an Academic Year, and its days were planned in {settings.timezone}. Changing the timezone
            now would move where each of those days begins and ends, so it can no longer change. See the{" "}
            <Link to={{ name: "academicYears", schoolId }}>Academic Years</Link>.
          </p>
        </section>
      ) : (
        <form onSubmit={onSetTimezone} aria-label="Change the timezone">
          <h2>Change the timezone</h2>
          <label>
            Timezone
            {/* Keyed on the timezone held, so the choice resets to it once a change lands. */}
            <select key={settings.timezone} name="timezone" required defaultValue={settings.timezone}>
              <TimezoneOptions current={settings.timezone} timezones={timezones} />
            </select>
          </label>
          <p className="muted">
            Choose the city whose clock the School keeps. It can be changed until the first Academic Year exists.
          </p>
          <button type="submit" disabled={busy}>
            Change timezone
          </button>
        </form>
      )}

      <form onSubmit={onProposeAttendanceWindow} aria-label="Change the Attendance window">
        <h2>Change the Attendance window</h2>
        <label>
          Days after a School date
          {/* Keyed on the window held, so the field resets to it once a change lands. */}
          <input
            key={settings.attendanceWindow}
            type="number"
            name="attendanceWindow"
            required
            min={0}
            max={MAX_ATTENDANCE_WINDOW}
            step={1}
            defaultValue={settings.attendanceWindow}
          />
        </label>
        <p className="muted">
          From 0, the same day only, to {MAX_ATTENDANCE_WINDOW}. You see how many past days it opens or closes before
          anything changes.
        </p>
        <button type="submit" disabled={busy}>
          Review change
        </button>
      </form>
    </Sheet>
  );
}

/**
 * The timezones on offer, grouped by the region each is named under, with the
 * School's own among them even when it is one no longer offered afresh, such
 * as a legacy alias.
 */
function TimezoneOptions({ current, timezones }: { current: string; timezones: string[] }) {
  const offered = timezones.includes(current) ? timezones : [current, ...timezones];
  const regions = new Map<string, string[]>();
  const ungrouped: string[] = [];
  for (const timezone of offered) {
    const slash = timezone.indexOf("/");
    if (slash === -1) {
      ungrouped.push(timezone);
      continue;
    }
    const region = timezone.slice(0, slash);
    regions.set(region, [...(regions.get(region) ?? []), timezone]);
  }
  return (
    <>
      {ungrouped.map((timezone) => (
        <option key={timezone} value={timezone}>
          {timezone}
        </option>
      ))}
      {[...regions].map(([region, members]) => (
        <optgroup key={region} label={region}>
          {members.map((timezone) => (
            <option key={timezone} value={timezone}>
              {cityOf(timezone)}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

/** A timezone as a reader names it: `America/Argentina/Buenos_Aires` is "Argentina / Buenos Aires". */
function cityOf(timezone: string): string {
  return timezone.slice(timezone.indexOf("/") + 1).replaceAll("_", " ").replaceAll("/", " / ");
}
