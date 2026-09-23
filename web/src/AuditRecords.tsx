import { useCallback, useState } from "react";
import { api, type AuditRecord, type ReachedSchool } from "./api.ts";
import { NotAvailable } from "./NotAvailable.tsx";
import { RecordList } from "./RecordList.tsx";
import { useScreen } from "./screen.ts";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";
import { namesOf } from "./standing.ts";

/** Which sheet this page is, named once so its states cannot drift apart. */
const SHEET: SheetKind = { name: "Audit" };

/** One page read so far: the cursor it was read from, and where in the trail it begins. */
interface Reached {
  cursor: string | null;
  /** How many records newer than this page there are, as far as paging has counted. */
  start: number;
}

/** The People list, read once for the screen rather than again with every page. */
const listPersons = (schoolId: string) => api.persons(schoolId);

/** A moment to the second: records written within one minute are told apart by it. */
const TO_THE_SECOND = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

/** What each kind of target is called, in the glossary's words. A Person and the School are named instead. */
const KINDS: Readonly<Record<string, string>> = {
  enrollment: "Enrollment",
  guardian_link: "Guardian link",
  invitation: "Invitation",
  membership: "School membership",
};

/**
 * The School's Audit records, one page at a time, newest first.
 *
 * Never the whole trail: it has no upper bound, so it is read a page at a time
 * and paged forward by the cursor each page carries (ADR-0008). Paging back
 * reads the earlier page again from the cursor it was first read from, so a
 * record written meanwhile lands on a first page read afresh and never shifts
 * the pages behind it.
 *
 * A record names who acted and what was acted on by identifier alone. The
 * sheet puts a Person's name to it from the People list the School
 * Administrator already reads, read once rather than with every page, and
 * prints the identifier under it for whoever needs it; it shows nothing about
 * anyone the record does not name.
 */
export function AuditRecords({ school }: { school: ReachedSchool }) {
  const { schoolId } = school;
  // Every page read so far, the one being read last. The first is the newest.
  const [pages, setPages] = useState<Reached[]>([{ cursor: null, start: 0 }]);
  const reading = pages.length;
  const reached = pages.at(-1)!;
  const list = useCallback(
    async (schoolId: string) => {
      const answered = await api.auditRecords(schoolId, reached.cursor);
      if (!answered.ok) {
        return answered;
      }
      // Carries which page it is, so a page still being read is never shown under the next one's number.
      return { ok: true as const, body: { ...answered.body, page: reading, start: reached.start } };
    },
    [reached, reading],
  );
  const { showing } = useScreen(schoolId, list);
  const people = useScreen(schoolId, listPersons).showing;

  if (showing.kind === "not-available" || people.kind === "not-available") {
    return <NotAvailable />;
  }
  if (showing.kind === "loading" || people.kind === "loading") {
    return <Sheet {...SHEET} busy />;
  }
  const { auditRecords, nextCursor, page, start } = showing.records;
  const { persons } = people.records;
  return (
    <AuditSheet
      school={school}
      auditRecords={auditRecords}
      nameOf={namesOf(persons)}
      page={page}
      start={start}
      reading={reading}
      onNewer={page > 1 ? () => setPages((read) => read.slice(0, -1)) : null}
      onOlder={
        nextCursor === null
          ? null
          : () => setPages((read) => [...read, { cursor: nextCursor, start: start + auditRecords.length }])
      }
    />
  );
}

function AuditSheet({
  school,
  auditRecords,
  nameOf,
  page,
  start,
  reading,
  onNewer,
  onOlder,
}: {
  school: ReachedSchool;
  auditRecords: AuditRecord[];
  nameOf: (personId: string) => string;
  page: number;
  start: number;
  /** The page asked for, which is not yet `page` while it is still being read. */
  reading: number;
  /** Null on the first page. */
  onNewer: (() => void) | null;
  /** Null on the last page. */
  onOlder: (() => void) | null;
}) {
  const legend = (
    <>
      <h2>Key</h2>
      <p>
        Every change made in this School, and every request it refused, newest first. Nothing on it can be changed or
        removed.
      </p>
      <dl>
        <Key term="Actor">Who acted: a Person of this School, a Platform Administrator, or no one signed in.</Key>
        <Key term="Action">What happened, as the record names it.</Key>
        <Key term="Target">What it was done to. A refused request is named by the path it asked for.</Key>
        <Key term="Reason">
          Why: the reason given for a change, or why a request was refused. Most changes are made without one.
        </Key>
        <Key term="Newer, Older">
          The trail is read a page at a time. A record written while you page lands on the first page, and moves no
          other.
        </Key>
      </dl>
    </>
  );

  const actorOf = (record: AuditRecord) => {
    if (record.actorPersonId !== null) {
      return <Named name={nameOf(record.actorPersonId)} id={record.actorPersonId} />;
    }
    if (record.actorPlatformAdministratorId !== null) {
      return <Named name="A Platform Administrator" id={record.actorPlatformAdministratorId} />;
    }
    return "No one signed in";
  };

  const targetOf = ({ target: { type, id } }: AuditRecord) => {
    if (id === null) {
      return KINDS[type] ?? type;
    }
    switch (type) {
      case "person":
        return <Named name={nameOf(id)} id={id} />;
      case "school":
        return <Named name={id === school.schoolId ? school.name : "A School"} id={id} />;
      case "request":
        return <code>{id}</code>;
      default:
        return <Named name={KINDS[type] ?? type} id={id} />;
    }
  };

  const paging = page !== reading;
  const end = start + auditRecords.length;
  const status = paging
    ? `Reading page ${reading}…`
    : auditRecords.length === 0
      ? `Page ${page}: no records.`
      : `Page ${page}: records ${start + 1} to ${end}, newest first${onOlder === null ? ". The last page." : "."}`;

  return (
    <Sheet {...SHEET} legend={legend}>
      <h1>Audit</h1>
      <nav className="pager" aria-label="Audit pages">
        <PageButton label="Newer" onPage={paging ? null : onNewer} />
        <p role="status">{status}</p>
        <PageButton label="Older" onPage={paging ? null : onOlder} />
      </nav>
      <RecordList
        label="Audit records"
        rows={auditRecords}
        keyOf={(record) => record.id}
        empty="Nothing has been recorded in this School yet."
        columns={[
          {
            head: "When",
            cell: (record) => <time dateTime={record.occurredAt}>{TO_THE_SECOND.format(new Date(record.occurredAt))}</time>,
          },
          { head: "Actor", cell: actorOf },
          { head: "Action", cell: (record) => <code>{record.action}</code> },
          { head: "Target", cell: targetOf },
          { head: "Reason", cell: (record) => record.reason ?? "None given" },
        ]}
      />
    </Sheet>
  );
}

/** What a record names, and under it the identifier it names it by, readable without hovering. */
function Named({ name, id }: { name: string; id: string }) {
  return (
    <>
      {name}
      <code className="identifier">{id}</code>
    </>
  );
}

/**
 * One way through the trail, held while there is nowhere to go. Held with
 * aria-disabled rather than disabled, so a keyboard user's focus stays on the
 * control they pressed when the end is reached.
 */
function PageButton({ label, onPage }: { label: string; onPage: (() => void) | null }) {
  return (
    <button type="button" className="button-ghost" aria-disabled={onPage === null} onClick={() => onPage?.()}>
      {label}
    </button>
  );
}
