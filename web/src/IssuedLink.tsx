import { useRef, useState } from "react";
import type { Invitation } from "./api.ts";
import { AcknowledgeDialog } from "./Dialog.tsx";

/** An Invitation just issued: the only time its link is ever known to the page. */
export interface IssuedInvitation {
  invitation: Invitation;
  link: string;
}

/**
 * The link to an Invitation just issued, with a way to copy it.
 *
 * It lives only in this page's memory. `issueInvitation` returns the link in
 * the one response that will ever carry it, so once this is closed the app has
 * no way to show it again and no way to ask for it: the only way to another
 * link is to revoke this Invitation and issue a fresh one.
 *
 * That is why it is held in a dialog that neither Escape nor a click beside it
 * will close. A link dismissed by accident strands the Invitation —
 * unredeemable, and needing a revoke and a reissue — so only the
 * acknowledgement closes it, after the sheet has said as much.
 */
export function IssuedLink({ issued, onDone }: { issued: IssuedInvitation; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(issued.link);
      setCopied(true);
    } catch {
      // Without clipboard access, the link is selected for copying by hand.
      field.current?.select();
    }
  };

  return (
    <AcknowledgeDialog
      title={`Invitation for ${issued.invitation.person.displayName}`}
      acknowledge="Done"
      onAcknowledge={onDone}
    >
      <p>Hand this link to them yourself. It is shown only now, and works once.</p>
      <label>
        Invitation link
        <input ref={field} readOnly value={issued.link} onFocus={(event) => event.currentTarget.select()} />
      </label>
      <div className="actions">
        <button type="button" onClick={copy}>
          Copy link
        </button>
        <span role="status" className={copied ? "mark mark--struck" : "mark"}>
          {copied ? "Copied" : ""}
        </span>
      </div>
      <p className="muted">
        Closing this is the last you will see of the link. The Invitation itself stays listed on Invitations until it
        is redeemed, expires, or is revoked.
      </p>
    </AcknowledgeDialog>
  );
}
