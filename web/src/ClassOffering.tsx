import { useCallback, useState, type FormEvent } from "react";
import { MAX_NAME_LENGTH } from "../../src/validation/bounds.ts";
import { api, type ApiResult, type ClassOffering as Offering, type ReachedSchool } from "./api.ts";
import { ConfirmDialog } from "./Dialog.tsx";
import { Link } from "./Link.tsx";
import { navigate } from "./navigation.ts";
import { NotAvailable } from "./NotAvailable.tsx";
import { courseTitle, labelConflictMessage, offeringName } from "./offerings.ts";
import { useScreen } from "./screen.ts";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";
import { schoolDay } from "./standing.ts";

/** Which sheet this page is, named once so its states cannot drift apart. */
const SHEET: SheetKind = { name: "Class Offering" };

/**
 * One Class Offering: the Course it offers and the Term it runs in, with the
 * ways to relabel and delete it. It opens from its own URL, so a bookmark to
 * it works.
 *
 * One that does not exist, or is another School's, is the one "not
 * available" state, as any refusal is (ADR-0002).
 */
export function ClassOffering({ school, classOfferingId }: { school: ReachedSchool; classOfferingId: string }) {
  const { schoolId } = school;
  // Stable for as long as the page shows one offering, so it is read once and again only after a change.
  const read = useCallback((schoolId: string) => api.classOffering(schoolId, classOfferingId), [classOfferingId]);
  const { showing, busy, change } = useScreen(schoolId, read);
  /** Held apart from the screen's own: a deleted offering is not read again, which would find it gone. */
  const [deleting, setDeleting] = useState(false);

  switch (showing.kind) {
    case "loading":
      return <Sheet {...SHEET} busy />;
    case "not-available":
      return <NotAvailable />;
    case "ready":
      return (
        <OfferingSheet
          schoolId={schoolId}
          offering={showing.records.classOffering}
          busy={busy || deleting}
          onRelabel={(label) => change(() => api.relabelClassOffering(schoolId, classOfferingId, label))}
          onDelete={async () => {
            setDeleting(true);
            const sent = await api.deleteClassOffering(schoolId, classOfferingId);
            if (sent.ok) {
              navigate({ name: "classOfferings", schoolId }, { replace: true });
              return;
            }
            setDeleting(false);
            // Settled as any failed change is, so it shows what every other failure shows.
            await change(async () => sent);
          }}
        />
      );
  }
}

function OfferingSheet({
  schoolId,
  offering,
  busy,
  onRelabel,
  onDelete,
}: {
  schoolId: string;
  offering: Offering;
  busy: boolean;
  onRelabel: (label: string | null) => Promise<ApiResult<unknown>>;
  onDelete: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** What the last change did, said once so a screen reader hears it land. */
  const [done, setDone] = useState("");
  const { course, term } = offering;

  const relabel = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const label = String(new FormData(event.currentTarget).get("label") ?? "").trim();
    setProblem(null);
    setDone("");
    const sent = await onRelabel(label === "" ? null : label);
    if (sent.ok) {
      setDone(label === "" ? "The label is removed." : `The label is now ${label}.`);
    } else if (sent.conflict !== undefined) {
      setProblem(labelConflictMessage(sent.conflict, course.name, term.name));
    }
  };

  const legend = (
    <>
      <h2>Key</h2>
      <p>One Course, offered for one Term.</p>
      <dl>
        <Key term="Class Offering">
          A Course offered for one Term. Offering it in another Term is another Class Offering.
        </Key>
        <Key term="Label">What tells this offering apart from the Course&rsquo;s others in the same Term.</Key>
      </dl>
    </>
  );

  return (
    <Sheet
      {...SHEET}
      legend={legend}
      foot={
        <p>
          <Link to={{ name: "classOfferings", schoolId }}>All Class Offerings</Link>
        </p>
      }
    >
      <h1>{offeringName(offering)}</h1>
      <dl className="facts">
        <dt>Course</dt>
        <dd>{courseTitle(course)}</dd>
        <dt>Term</dt>
        <dd>
          {term.name}, {term.academicYear.name}
        </dd>
        <dt>Runs</dt>
        <dd>
          {schoolDay(term.firstDate)} to {schoolDay(term.lastDate)}
        </dd>
        <dt>Label</dt>
        <dd>{offering.label ?? <span className="muted">None</span>}</dd>
      </dl>
      <p className="muted" role="status">
        {done}
      </p>

      <form onSubmit={relabel} aria-label="Relabel this Class Offering">
        <h2>Relabel</h2>
        <label>
          Label (optional)
          <input
            // Keyed by the label as it stands, so the field shows it afresh once a change lands.
            key={offering.label ?? ""}
            name="label"
            maxLength={MAX_NAME_LENGTH}
            autoComplete="off"
            defaultValue={offering.label ?? ""}
          />
        </label>
        {problem !== null && (
          <p role="alert" className="error">
            {problem}
          </p>
        )}
        <p className="actions">
          <button type="submit" disabled={busy}>
            Save label
          </button>
          <button type="button" className="button-stamp" disabled={busy} onClick={() => setConfirming(true)}>
            Delete Class Offering
          </button>
        </p>
      </form>

      {confirming && (
        <ConfirmDialog
          title={`Delete ${offeringName(offering)}?`}
          confirm="Delete the Class Offering"
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            setConfirming(false);
            setDone("");
            await onDelete();
          }}
        >
          <p>
            {course.name} is no longer offered in {term.name} under this offering. The Course and the Term stay as they
            are.
          </p>
        </ConfirmDialog>
      )}
    </Sheet>
  );
}
