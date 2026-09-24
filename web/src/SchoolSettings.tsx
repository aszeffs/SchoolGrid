import { useState, type FormEvent } from "react";
import { api, type ReachedSchool, type SchoolSettings as Settings } from "./api.ts";
import { Link } from "./Link.tsx";
import { NotAvailable } from "./NotAvailable.tsx";
import { useScreen } from "./screen.ts";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";

/** Which sheet this page is, named once so its states cannot drift apart. */
const SHEET: SheetKind = { name: "School settings" };

/**
 * What a School Administrator configures about their School. For now that is
 * its timezone alone: where each of the School's days begins and ends.
 *
 * The session names this page to a School Administrator only (ADR-0007), and
 * the server refuses anyone else with the one "not available" state.
 */
export function SchoolSettings({ school }: { school: ReachedSchool }) {
  const { schoolId } = school;
  const { showing, busy, change } = useScreen(schoolId, api.schoolSettings);
  /** The timezone just set, said once so a screen reader hears the change land. */
  const [changed, setChanged] = useState<string | null>(null);

  const setTimezone = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const timezone = String(new FormData(event.currentTarget).get("timezone") ?? "");
    setChanged(null);
    const sent = await change(() => api.setTimezone(schoolId, timezone));
    if (sent.ok) {
      setChanged(sent.body.settings.timezone);
    }
  };

  switch (showing.kind) {
    case "loading":
      return <Sheet {...SHEET} busy />;
    case "not-available":
      return <NotAvailable />;
    case "ready":
      return (
        <SettingsSheet
          schoolId={schoolId}
          settings={showing.records.settings}
          timezones={showing.records.timezones}
          busy={busy}
          changed={changed}
          onSetTimezone={setTimezone}
        />
      );
  }
}

function SettingsSheet({
  schoolId,
  settings,
  timezones,
  busy,
  changed,
  onSetTimezone,
}: {
  schoolId: string;
  settings: Settings;
  timezones: string[];
  busy: boolean;
  changed: string | null;
  onSetTimezone: (event: FormEvent<HTMLFormElement>) => void;
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
      </dl>
    </>
  );

  return (
    <Sheet {...SHEET} legend={legend}>
      <h1>School settings</h1>
      <dl className="facts">
        <dt>Timezone</dt>
        <dd>{settings.timezone}</dd>
      </dl>
      <p className="muted" role="status">
        {changed === null ? "" : `The School now keeps its days in ${changed}.`}
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
