import { useRef, useState } from "react";
import type { Invitation } from "./api.ts";

/** An Invitation just issued: the only time its link is ever known to the page. */
export interface IssuedInvitation {
  invitation: Invitation;
  link: string;
}

/**
 * The link to an Invitation just issued, with a way to copy it. It lives only
 * in this page's memory: the API never serves it again, so once the School
 * Administrator leaves the page it is gone, and a fresh Invitation replaces it.
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
    <section aria-labelledby="issued-invitation" className="issued">
      <h2 id="issued-invitation">Invitation for {issued.invitation.person.displayName}</h2>
      <p>Hand this link to them yourself. It is shown only now, and works once.</p>
      <label>
        Invitation link
        <input ref={field} readOnly value={issued.link} onFocus={(event) => event.currentTarget.select()} />
      </label>
      <div className="actions">
        <button type="button" onClick={copy}>
          Copy link
        </button>
        <button type="button" onClick={onDone}>
          Done
        </button>
        <span role="status" className="muted">
          {copied ? "Copied" : ""}
        </span>
      </div>
    </section>
  );
}

const EXPIRY = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The School's pending Invitations, each of which can be revoked. */
export function PendingInvitations({
  invitations,
  busy,
  onRevoke,
}: {
  invitations: Invitation[];
  busy: boolean;
  onRevoke: (invitation: Invitation) => void;
}) {
  return (
    <section aria-labelledby="pending-invitations">
      <h2 id="pending-invitations">Pending Invitations</h2>
      {invitations.length === 0 ? (
        <p className="muted">No Invitations are pending.</p>
      ) : (
        <ul aria-label="Pending Invitations" className="persons">
          {invitations.map((invitation) => (
            <li key={invitation.id}>
              <span>
                {invitation.person.displayName}
                <br />
                <span className="muted">Expires {EXPIRY.format(new Date(invitation.expiresAt))}</span>
              </span>
              <button
                type="button"
                disabled={busy}
                aria-label={`Revoke the Invitation for ${invitation.person.displayName}`}
                onClick={() => onRevoke(invitation)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
