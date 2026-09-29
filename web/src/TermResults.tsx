import { useCallback, useState, type FormEvent } from "react";
import { NO_CONTENT, sameContent } from "../../src/results/term-results.ts";
import { MAX_TERM_RESULT_COMMENT_LENGTH, MAX_TERM_RESULT_SCORE } from "../../src/validation/bounds.ts";
import {
  api,
  readAll,
  type ApiResult,
  type ClassOfferingResults,
  type ReachedSchool,
  type RefusedDraft,
  type TaughtClassOffering as Offering,
  type TermResult,
  type TermResultContent,
  type TermResultDraft,
} from "./api.ts";
import { Link } from "./Link.tsx";
import { NotAvailable } from "./NotAvailable.tsx";
import { offeringName } from "./offerings.ts";
import { RecordList } from "./RecordList.tsx";
import { useScreen } from "./screen.ts";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";
import { formatSchoolDate, MOMENT } from "./standing.ts";

/** Which sheet this page is, named once so its states cannot drift apart. */
const SHEET: SheetKind = { name: "Term results" };

type Student = ClassOfferingResults["students"][number];

/** One Student's result as it is being edited: each field as typed, blank for none. */
interface Entry {
  value: string;
  score: string;
  comment: string;
}

/**
 * One Class Offering's Term results, drafts included. It opens from its own
 * URL, so a bookmark to it works.
 *
 * A Faculty member currently teaching the offering gives each Student ever
 * rostered in it, one who withdrew included, a value from the current scale,
 * an optional score and an optional comment, and saves with any left without
 * a value. A draft a co-teacher changed since this page read it is refused and
 * shown in place with its newer content, never overwritten.
 *
 * A School Administrator, and a Faculty member whose assignment has ended,
 * read the drafts with why they cannot record them said plainly. Anyone else,
 * and an offering that does not exist or is another School's, is the one "not
 * available" state (ADR-0002).
 */
export function TermResults({ school, classOfferingId }: { school: ReachedSchool; classOfferingId: string }) {
  const { schoolId } = school;
  // Stable for as long as the page shows one offering, so it is read once and again only after a change.
  const read = useCallback(
    async (schoolId: string): Promise<ApiResult<{ classOffering: Offering; classOfferingResults: ClassOfferingResults }>> => {
      const answered = await readAll([
        api.classOffering(schoolId, classOfferingId),
        api.classOfferingResults(schoolId, classOfferingId),
      ]);
      if (!answered.ok) {
        return answered;
      }
      const [{ classOffering }, { classOfferingResults }] = answered.body;
      return { ok: true, body: { classOffering, classOfferingResults } };
    },
    [classOfferingId],
  );
  const { showing, busy, change } = useScreen(schoolId, read);

  switch (showing.kind) {
    case "loading":
      return <Sheet {...SHEET} busy />;
    case "not-available":
      return <NotAvailable />;
    case "ready": {
      const { classOffering, classOfferingResults } = showing.records;
      return (
        <ResultsSheet
          schoolId={schoolId}
          administers={school.roles.includes("school_administrator")}
          offering={classOffering}
          results={classOfferingResults}
          busy={busy}
          onSave={(drafts) => change(() => api.saveTermResults(schoolId, classOfferingId, drafts))}
        />
      );
    }
  }
}

function ResultsSheet({
  schoolId,
  administers,
  offering,
  results,
  busy,
  onSave,
}: {
  schoolId: string;
  administers: boolean;
  offering: Offering;
  results: ClassOfferingResults;
  busy: boolean;
  onSave: (
    drafts: TermResultDraft[],
  ) => Promise<ApiResult<{ classOfferingResults: ClassOfferingResults; refusedDrafts: RefusedDraft[] }>>;
}) {
  /** The results edited and not yet saved, by Student. */
  const [entries, setEntries] = useState<ReadonlyMap<string, Entry>>(new Map());
  /** The drafts the last save refused, by Student, each with the value it tried to give, said beside each until the next save. */
  const [refused, setRefused] = useState<ReadonlyMap<string, { refusal: RefusedDraft; tried: string | null }>>(new Map());
  /** What the last save did, said once so a screen reader hears it land. */
  const [done, setDone] = useState("");
  const { resultValueScale: scale, readOnlyBecause, students } = results;
  const recordable = readOnlyBecause === null;
  const { term } = offering;

  const entryOf = (student: Student): Entry => entries.get(student.person.id) ?? entryFrom(student.termResult);
  const edit = (student: Student, field: keyof Entry, typed: string) => {
    setEntries((held) => new Map(held).set(student.person.id, { ...entryOf(student), [field]: typed }));
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDone("");
    const drafts = students.flatMap((student): TermResultDraft[] => {
      const entry = entries.get(student.person.id);
      if (entry === undefined) {
        return [];
      }
      const loaded = contentOf(student.termResult);
      const content = contentFrom(entry);
      return sameContent(content, loaded ?? NO_CONTENT)
        ? []
        : [{ studentPersonId: student.person.id, loaded, ...content }];
    });
    const tried = new Map(drafts.map((draft) => [draft.studentPersonId, draft.value]));
    const sent = await onSave(drafts);
    if (sent.ok) {
      setEntries(new Map());
      const { refusedDrafts } = sent.body;
      setRefused(
        new Map(
          refusedDrafts.map((refusal) => [refusal.studentPersonId, { refusal, tried: tried.get(refusal.studentPersonId) ?? null }]),
        ),
      );
      setDone(
        refusedDrafts.length === 0
          ? "Saved."
          : `Saved. ${refusedDrafts.length === 1 ? "One result was" : `${refusedDrafts.length} results were`} not saved: see beside ${refusedDrafts.length === 1 ? "it" : "each"}.`,
      );
    }
  };

  const legend = (
    <>
      <h2>Key</h2>
      <p>How each Student did in this class over its Term, recorded by whoever teaches it.</p>
      <dl>
        <Key term="Term result">
          One Student&rsquo;s value from the School&rsquo;s scale, with an optional score from 0 to 100 and an optional
          comment.
        </Key>
        <Key term="Draft">
          A result not yet published. Only the Faculty teaching this class and School Administrators see it. It saves
          with Students still left without a value.
        </Key>
        <Key term="Changed since you opened it">
          A result someone else changed after you opened this page is not overwritten: it is shown to you with its
          newer content.
        </Key>
        <Key term={`Result value scale, version ${scale.version}`}>
          {scale.values.map((value) => (value.description === null ? value.label : `${value.label}: ${value.description}`)).join(". ")}
          . A result keeps the version its value was given from.
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
        <dt>Term</dt>
        <dd>
          {term.name}, {term.academicYear.name}
        </dd>
        <dt>Runs</dt>
        <dd>
          {formatSchoolDate(term.firstDate)} to {formatSchoolDate(term.lastDate)}
        </dd>
        <dt>Scale</dt>
        <dd>
          Version {scale.version}: {scale.values.map((value) => value.label).join(", ")}
        </dd>
      </dl>

      {!recordable && (
        <p className="notice">
          {administers
            ? "School Administrators read draft Term results here. The Faculty teaching this class record them."
            : "You are not teaching this class now, so you can read its draft Term results but not record them."}
        </p>
      )}

      <form onSubmit={save} aria-label="Record Term results" className="term-results">
        <h2>Term results</h2>
        <RecordList
          label="Term results"
          rows={students}
          keyOf={(student) => student.person.id}
          empty="No Student has been on this roster."
          columns={[
            {
              head: "Student",
              cell: (student) => {
                const left = leftOn(student, term.lastDate);
                return (
                  <>
                    {student.person.displayName}
                    {left !== null && (
                      <>
                        {" "}
                        <span className="mark mark--struck">Left {formatSchoolDate(left)}</span>
                      </>
                    )}
                  </>
                );
              },
            },
            {
              head: "Value",
              cell: (student) => {
                const name = student.person.displayName;
                const held = refused.get(student.person.id);
                const noteId = `refused-${student.person.id}`;
                const stored = student.termResult?.value ?? null;
                const offered = scale.values.map((value) => value.label);
                return (
                  <>
                    {recordable ? (
                      <select
                        aria-label={`${name}’s value`}
                        aria-describedby={held === undefined ? undefined : noteId}
                        disabled={busy}
                        value={entryOf(student).value}
                        onChange={(event) => edit(student, "value", event.currentTarget.value)}
                      >
                        <option value="">No value</option>
                        {stored !== null && !offered.includes(stored) && (
                          <option value={stored}>{stored} (version {student.termResult?.scaleVersion})</option>
                        )}
                        {offered.map((label) => (
                          <option key={label} value={label}>
                            {label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      (stored ?? <span className="muted">No value</span>)
                    )}
                    {held !== undefined && (
                      <p id={noteId} className="error">
                        {refusalText(held.refusal, held.tried)}
                      </p>
                    )}
                  </>
                );
              },
            },
            {
              head: "Score",
              cell: (student) =>
                recordable ? (
                  <input
                    type="number"
                    className="term-results__score"
                    aria-label={`${student.person.displayName}’s score, 0 to ${MAX_TERM_RESULT_SCORE}`}
                    inputMode="decimal"
                    min={0}
                    max={MAX_TERM_RESULT_SCORE}
                    step={0.1}
                    disabled={busy}
                    value={entryOf(student).score}
                    onChange={(event) => edit(student, "score", event.currentTarget.value)}
                  />
                ) : (
                  (student.termResult?.score ?? <span className="muted">None</span>)
                ),
            },
            {
              head: "Comment",
              cell: (student) =>
                recordable ? (
                  <textarea
                    className="term-results__comment"
                    aria-label={`${student.person.displayName}’s comment`}
                    maxLength={MAX_TERM_RESULT_COMMENT_LENGTH}
                    rows={2}
                    disabled={busy}
                    value={entryOf(student).comment}
                    onChange={(event) => edit(student, "comment", event.currentTarget.value)}
                  />
                ) : (
                  (student.termResult?.comment ?? <span className="muted">None</span>)
                ),
            },
            { head: "Recorded", cell: (student) => recordedText(student.termResult) },
          ]}
        />
        {recordable && students.length > 0 && (
          <p className="actions">
            <button type="submit" disabled={busy || entries.size === 0}>
              Save
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

/** What a stored result says, as a save carries it back; null for a Student with none. */
function contentOf(result: TermResult | null): TermResultContent | null {
  return result === null ? null : { value: result.value, score: result.score, comment: result.comment };
}

function entryFrom(result: TermResult | null): Entry {
  return {
    value: result?.value ?? "",
    score: result?.score === null || result?.score === undefined ? "" : String(result.score),
    comment: result?.comment ?? "",
  };
}

/** What an entry says, a blank field saying nothing. A comment of only spaces says nothing too. */
function contentFrom({ value, score, comment }: Entry): TermResultContent {
  return {
    value: value === "" ? null : value,
    score: score.trim() === "" ? null : Number(score),
    comment: comment.trim() === "" ? null : comment,
  };
}

/** The School date a Student left the roster, when every Roster membership of theirs ended before the Term did. */
function leftOn(student: Student, termLastDate: string): string | null {
  const last = student.rosterMemberships.map((membership) => membership.lastDate ?? termLastDate).sort().at(-1);
  return last !== undefined && last < termLastDate ? last : null;
}

/** Who last recorded a result and when, or that nobody has. */
function recordedText(result: TermResult | null): string {
  return result === null ? "Not yet" : `${result.recordedBy.displayName}, ${MOMENT.format(new Date(result.recordedAt))}`;
}

/** A result's content in a few words: its value, score and comment, as far as it has them. */
function summaryOf(result: TermResultContent): string {
  return [
    result.value ?? "no value",
    ...(result.score === null ? [] : [`score ${result.score}`]),
    ...(result.comment === null ? [] : [`“${result.comment}”`]),
  ].join(", ");
}

/** Why one draft was not saved, beside the Student it was for. */
function refusalText({ because, termResult }: RefusedDraft, tried: string | null): string {
  switch (because) {
    case "stale":
      return termResult === null
        ? "This result changed after you opened the page. Your change was not saved."
        : `${termResult.recordedBy.displayName} changed this result at ${MOMENT.format(new Date(termResult.recordedAt))}, after you opened the page: ${summaryOf(termResult)}. Your change was not saved.`;
    case "value_not_in_scale":
      return `${tried ?? "That value"} is no longer on the Result value scale. Your change was not saved.`;
  }
}
