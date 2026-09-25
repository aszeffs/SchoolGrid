import { useState } from "react";
import type { ClassOffering } from "./api.ts";
import { ConfirmDialog } from "./Dialog.tsx";

/**
 * Asks for a Teaching assignment's or Roster membership's new dates, inside its
 * Term, and names what they mean before they are set.
 */
export function ChangeDates({
  held,
  whose,
  term,
  busy,
  onCancel,
  onSave,
}: {
  /** The dates it holds now. */
  held: { firstDate: string; lastDate: string | null };
  /** Whose participation it is, as the title names it: "Sam’s Roster membership". */
  whose: string;
  term: ClassOffering["term"];
  busy: boolean;
  onCancel: () => void;
  onSave: (bounds: { firstDate: string; lastDate: string | null }) => void;
}) {
  const [firstDate, setFirstDate] = useState(held.firstDate);
  const [lastDate, setLastDate] = useState(held.lastDate ?? "");
  const inOrder = lastDate === "" || lastDate >= firstDate;
  return (
    <ConfirmDialog
      title={`Change the dates of ${whose}?`}
      confirm="Save the dates"
      busy={busy || firstDate === "" || !inOrder}
      onCancel={onCancel}
      onConfirm={() => onSave({ firstDate, lastDate: lastDate === "" ? null : lastDate })}
    >
      <p>
        Both days are included, and both fall inside {term.name}. Left without an end, it runs to the Term&rsquo;s
        last day.
      </p>
      <label>
        From
        <input
          type="date"
          name="firstDate"
          required
          min={term.firstDate}
          max={term.lastDate}
          value={firstDate}
          onChange={(event) => setFirstDate(event.currentTarget.value)}
        />
      </label>
      <label>
        Until (optional)
        <input
          type="date"
          name="lastDate"
          min={firstDate === "" ? term.firstDate : firstDate}
          max={term.lastDate}
          value={lastDate}
          onChange={(event) => setLastDate(event.currentTarget.value)}
        />
      </label>
    </ConfirmDialog>
  );
}
