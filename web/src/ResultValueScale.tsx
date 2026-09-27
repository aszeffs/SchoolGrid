import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  MAX_RESULT_VALUE_DESCRIPTION_LENGTH,
  MAX_RESULT_VALUE_LABEL_LENGTH,
  MAX_RESULT_VALUES,
} from "../../src/validation/bounds.ts";
import type { ApiResult, ResultValue, ResultValueScale as Scale } from "./api.ts";
import { ConfirmDialog } from "./Dialog.tsx";

/** One value as it is being edited, keyed so its fields keep their place while the list is reordered. */
interface Draft {
  key: number;
  label: string;
  description: string;
}

/** Which control to put the focus back on once a move has re-rendered the list. */
interface Refocus {
  key: number;
  control: "up" | "down";
}

/**
 * A School's Result value scale on School settings: the current version's
 * values in their order, and the one form that changes them. Values are
 * added, renamed, described, removed and reordered in place, and nothing is
 * sent until the whole list is saved, after a confirmation, as the next
 * version. Results already recorded keep the version they were bound to.
 */
export function ResultValueScale({
  scale,
  busy,
  onSave,
}: {
  scale: Scale;
  busy: boolean;
  /** Sends the values as the next version, and answers what the server did. */
  onSave: (values: ResultValue[]) => Promise<ApiResult<{ resultValueScale: Scale }>>;
}) {
  return (
    <section aria-labelledby="result-value-scale">
      <h2 id="result-value-scale">Result value scale</h2>
      <p className="muted">
        Version {scale.version}. Faculty give each Term result one of these values, in this order.
      </p>
      <ol className="scale-values">
        {scale.values.map((value) => (
          <li key={value.label}>
            <strong>{value.label}</strong>
            {value.description !== null && <span className="muted"> — {value.description}</span>}
          </li>
        ))}
      </ol>
      {/* Keyed on the version held, so the form starts again from it once a save lands. */}
      <ScaleEditor key={scale.version} scale={scale} busy={busy} onSave={onSave} />
    </section>
  );
}

function ScaleEditor({
  scale,
  busy,
  onSave,
}: {
  scale: Scale;
  busy: boolean;
  onSave: (values: ResultValue[]) => Promise<ApiResult<{ resultValueScale: Scale }>>;
}) {
  const nextKey = useRef(scale.values.length);
  const [drafts, setDrafts] = useState<Draft[]>(
    scale.values.map(({ label, description }, key) => ({ key, label, description: description ?? "" })),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [proposed, setProposed] = useState<ResultValue[] | null>(null);
  const [refocus, setRefocus] = useState<Refocus | null>(null);

  // A moved value's row is re-rendered elsewhere in the list, so the control
  // that moved it is found again, or its other one when it cannot move further.
  useEffect(() => {
    if (refocus === null) {
      return;
    }
    const at = drafts.findIndex((draft) => draft.key === refocus.key);
    const blocked = refocus.control === "up" ? at === 0 : at === drafts.length - 1;
    const control = blocked ? (refocus.control === "up" ? "down" : "up") : refocus.control;
    document.getElementById(moveControlId(refocus.key, control))?.focus();
    setRefocus(null);
  }, [refocus, drafts]);

  const setField = (key: number, field: "label" | "description", value: string) =>
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, [field]: value } : draft)));

  const move = (at: number, by: -1 | 1) => {
    const moved = drafts[at]!;
    setDrafts((current) => {
      const next = [...current];
      [next[at], next[at + by]] = [next[at + by]!, next[at]!];
      return next;
    });
    setRefocus({ key: moved.key, control: by === -1 ? "up" : "down" });
  };

  const add = () => {
    const key = nextKey.current++;
    setDrafts((current) => [...current, { key, label: "", description: "" }]);
    // The new value's label is where the next keystroke belongs.
    requestAnimationFrame(() => document.getElementById(labelId(key))?.focus());
  };

  const remove = (key: number) => setDrafts((current) => current.filter((draft) => draft.key !== key));

  // Checks what the server would refuse before asking for a confirmation, so
  // the dialog only ever confirms a save that can land.
  const review = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = drafts.map(({ label, description }) => ({
      label: label.trim(),
      description: description.trim() === "" ? null : description.trim(),
    }));
    const found = scaleProblem(values, scale.values);
    setProblem(found);
    if (found === null) {
      setProposed(values);
    }
  };

  const save = async (values: ResultValue[]) => {
    const sent = await onSave(values);
    setProposed(null);
    if (!sent.ok) {
      setProblem(
        sent.conflict?.conflict === "unchanged"
          ? "The scale already holds these values."
          : "That change is not available.",
      );
    }
  };

  return (
    <form onSubmit={review} aria-label="Change the Result value scale">
      <h3>Change the scale</h3>
      <p className="muted">
        Each label is short and differs from every other, ignoring letter case. Saving makes a new version; results
        already recorded keep theirs.
      </p>
      {drafts.length === 0 && <p className="empty">No values. Add at least one.</p>}
      {drafts.map((draft, index) => (
        <fieldset key={draft.key} className="value-draft">
          <legend>Value {index + 1}</legend>
          <label>
            Label
            <input
              id={labelId(draft.key)}
              required
              maxLength={MAX_RESULT_VALUE_LABEL_LENGTH}
              autoComplete="off"
              value={draft.label}
              onChange={(event) => setField(draft.key, "label", event.currentTarget.value)}
            />
          </label>
          <label>
            Description (optional)
            <input
              maxLength={MAX_RESULT_VALUE_DESCRIPTION_LENGTH}
              autoComplete="off"
              value={draft.description}
              onChange={(event) => setField(draft.key, "description", event.currentTarget.value)}
            />
          </label>
          <p className="actions">
            <button
              type="button"
              id={moveControlId(draft.key, "up")}
              className="button-quiet"
              disabled={busy || index === 0}
              onClick={() => move(index, -1)}
            >
              Move value {index + 1} up
            </button>
            <button
              type="button"
              id={moveControlId(draft.key, "down")}
              className="button-quiet"
              disabled={busy || index === drafts.length - 1}
              onClick={() => move(index, 1)}
            >
              Move value {index + 1} down
            </button>
            <button type="button" className="button-quiet" disabled={busy} onClick={() => remove(draft.key)}>
              Remove value {index + 1}
            </button>
          </p>
        </fieldset>
      ))}
      <button type="button" className="button-ghost" disabled={busy || drafts.length >= MAX_RESULT_VALUES} onClick={add}>
        Add a value
      </button>
      {problem !== null && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <button type="submit" disabled={busy}>
        Review scale
      </button>
      {proposed !== null && (
        <ConfirmDialog
          title="Save a new version of the scale?"
          confirm={`Save version ${scale.version + 1}`}
          busy={busy}
          onCancel={() => setProposed(null)}
          onConfirm={() => void save(proposed)}
        >
          <p>
            Version {scale.version + 1} will hold {proposed.map((value) => value.label).join(", ")}, in that order.
          </p>
          <p className="notice">
            Results already recorded keep version {scale.version}. Version {scale.version} stays stored.
          </p>
        </ConfirmDialog>
      )}
    </form>
  );
}

/** Why the server would refuse these values, said as the page says it, or null when it would not. */
function scaleProblem(values: ResultValue[], current: ResultValue[]): string | null {
  if (values.length === 0) {
    return "A scale needs at least one value.";
  }
  const blank = values.findIndex((value) => value.label === "");
  if (blank !== -1) {
    return `Value ${blank + 1} needs a label.`;
  }
  const seen = new Map<string, number>();
  for (const [index, { label }] of values.entries()) {
    const first = seen.get(label.toLowerCase());
    if (first !== undefined) {
      return `Values ${first + 1} and ${index + 1} are both labelled ${label}. Each label must differ, ignoring letter case.`;
    }
    seen.set(label.toLowerCase(), index);
  }
  const unchanged =
    values.length === current.length &&
    values.every(
      (value, index) => value.label === current[index]!.label && value.description === current[index]!.description,
    );
  return unchanged ? "The scale already holds these values." : null;
}

function labelId(key: number): string {
  return `result-value-${key}-label`;
}

function moveControlId(key: number, control: "up" | "down"): string {
  return `result-value-${key}-${control}`;
}
