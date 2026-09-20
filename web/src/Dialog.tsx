import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * A slip torn off the sheet and held over it: the app's one overlay.
 *
 * It is a native `<dialog>` opened with `showModal()`, and not a kit's
 * component, because `style-src 'self'` has no inline exception and the build
 * fails on a `style=` attribute — the libraries position their overlays with
 * one (ADR-0006). The element brings what the kit is usually adopted for:
 * the rest of the page goes inert, focus moves inside and is trapped there,
 * and Escape asks to close.
 *
 * A dialog is open for as long as it is rendered. There is no `open` prop to
 * fall out of step with that: mounting it opens it, and unmounting it closes
 * it and hands the focus back.
 *
 * Two shapes, and nothing else. `AcknowledgeDialog` holds something the server
 * will never say again, so it cannot be dismissed by accident. `ConfirmDialog`
 * names what an action will do before it is done, and cancelling does nothing.
 */
function Dialog({
  title,
  kind,
  dismiss,
  children,
  actions,
}: {
  title: string;
  /** Which of the two shapes this is, struck into the class so the sheet says so. */
  kind: "acknowledge" | "confirm";
  /**
   * What an Escape or a press beside the slip means. `null` is the decision
   * that this dialog refuses both and closes only through one of its actions.
   */
  dismiss: (() => void) | null;
  children: ReactNode;
  actions: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) {
      return;
    }
    /*
     * Where focus was when the dialog opened, so it can be put back. The
     * browser restores it on close too, but only while the element it came
     * from is still on the page; holding it here means a trigger that survives
     * the change gets focus back even after the record around it is redrawn.
     */
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger !== null && trigger.isConnected) {
        trigger.focus();
      }
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={`slip slip--${kind}`}
      aria-labelledby={headingId}
      onCancel={(event) => {
        // A dialog with no way to cancel refuses the request rather than
        // closing: Escape must not lose a link that is shown only once.
        if (dismiss === null) {
          event.preventDefault();
        } else {
          dismiss();
        }
      }}
      onMouseDown={(event) => {
        /*
         * A press beside the slip, on the veil. A press there reports the
         * dialog itself as its target, the same as a press on the slip does,
         * so the target alone does not tell the two apart; where it fell
         * relative to the slip's rectangle does.
         */
        if (dismiss === null || event.target !== event.currentTarget) {
          return;
        }
        const { top, right, bottom, left } = event.currentTarget.getBoundingClientRect();
        const beside =
          event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom;
        if (beside) {
          dismiss();
        }
      }}
    >
      <h2 id={headingId}>{title}</h2>
      {children}
      <div className="actions">{actions}</div>
    </dialog>
  );
}

/**
 * A dialog holding something that will not be shown again — an Invitation's
 * link above all. Neither Escape nor a press beside it closes it; only the
 * acknowledgement does, so it cannot be dismissed by a stray keystroke.
 */
export function AcknowledgeDialog({
  title,
  acknowledge,
  onAcknowledge,
  children,
}: {
  title: string;
  /** The label on the one control that closes this dialog. */
  acknowledge: string;
  onAcknowledge: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      title={title}
      kind="acknowledge"
      dismiss={null}
      actions={
        <button type="button" className="button-ghost" onClick={onAcknowledge}>
          {acknowledge}
        </button>
      }
    >
      {children}
    </Dialog>
  );
}

/**
 * A dialog that names what an action will do before it is done. Cancelling —
 * by the control, by Escape, or by a press beside the slip — sends nothing, so
 * the server is left exactly as it was.
 *
 * Cancel holds the focus on open: the consequence should be read before the
 * key that confirms it is within reach.
 */
export function ConfirmDialog({
  title,
  confirm,
  onConfirm,
  onCancel,
  busy = false,
  children,
}: {
  title: string;
  /** The label on the control that goes ahead, naming the act, not "OK". */
  confirm: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <Dialog
      title={title}
      kind="confirm"
      dismiss={onCancel}
      actions={
        <>
          <button type="button" className="button-ghost" autoFocus onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button-stamp" disabled={busy} onClick={onConfirm}>
            {confirm}
          </button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
