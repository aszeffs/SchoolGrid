import { useRef, useState } from "react";
import type { Invitation } from "./api.ts";
import { AcknowledgeDialog, ConfirmDialog } from "./Dialog.tsx";
import { RecordList } from "./RecordList.tsx";

/** An Invitation just issued: the only time its link is ever known to the page. */
export interface IssuedInvitation {
  invitation: Invitation;
  link: string;
}

/**
 * The link to an Invitation just issued, with a way to copy it. It lives only
 * in this page's memory: the API never serves it again, so once the School
 * Administrator leaves the page it is gone, and a fresh Invitation replaces it.
 *
 * It is held in a dialog that neither Escape nor a click beside it will close,
 * because a link dismissed by accident strands the Invitation — unredeemable,
 * and needing a revoke and a reissue. Only the acknowledgement closes it.
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
      <p className="muted">Closing this is the last you will see of the link.</p>
    </AcknowledgeDialog>
  );
}

const EXPIRY = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * The School's pending Invitations, each of which can be revoked.
 *
 * Revoking is confirmed in a dialog that names what it does to the link
 * already handed out. Cancelling sends nothing, so the server is left exactly
 * as it was.
 */
export function PendingInvitations({
  invitations,
  busy,
  onRevoke,
}: {
  invitations: Invitation[];
  busy: boolean;
  onRevoke: (invitation: Invitation) => void;
}) {
  const [confirming, setConfirming] = useState<Invitation | null>(null);

  return (
    <section aria-labelledby="pending-invitations">
      <h2 id="pending-invitations">Pending Invitations</h2>
      <RecordList
        label="Pending Invitations"
        rows={invitations}
        keyOf={(invitation) => invitation.id}
        empty="No Invitations are pending."
        columns={[
          { head: "Person", cell: (invitation) => invitation.person.displayName },
          { head: "Expires", cell: (invitation) => EXPIRY.format(new Date(invitation.expiresAt)) },
          {
            head: "Revoke",
            actions: true,
            cell: (invitation) => (
              <button
                type="button"
                className="button-stamp"
                disabled={busy}
                aria-label={`Revoke the Invitation for ${invitation.person.displayName}`}
                onClick={() => setConfirming(invitation)}
              >
                Revoke
              </button>
            ),
          },
        ]}
      />
      {confirming !== null && (
        <ConfirmDialog
          title="Revoke this Invitation?"
          confirm="Revoke the Invitation"
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const invitation = confirming;
            setConfirming(null);
            onRevoke(invitation);
          }}
        >
          <p>
            The link issued for {confirming.person.displayName} stops working, whoever is holding it.{" "}
            {confirming.person.displayName} stays Unclaimed, and nothing else about the Person changes.
          </p>
          <p>To let someone claim this Person after this, issue a new Invitation and hand out the new link.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
