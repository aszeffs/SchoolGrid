import { useEffect, useState } from "react";
import { api, type Invitation, type ReachedSchool } from "./api.ts";
import { ConfirmDialog } from "./Dialog.tsx";
import { afterFailure } from "./failed.ts";
import { Link } from "./Link.tsx";
import { NotAvailable } from "./NotAvailable.tsx";
import { RecordList } from "./RecordList.tsx";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";

type State = { kind: "loading" } | { kind: "not-available" } | { kind: "ready"; invitations: Invitation[] };

/**
 * Which sheet this page is, named once so its states cannot drift apart.
 *
 * The Invitation's two sides run on the one stock: this sheet and the one a
 * human lands on when they follow a link are the same business seen from its
 * two ends.
 */
const SHEET: SheetKind = { stock: "pink", name: "Invitations" };

const EXPIRY = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Every Invitation this School has pending, when each expires, and the way to
 * revoke one.
 *
 * A screen of its own rather than a panel on People, because an Invitation
 * outlives the moment it was issued in: it is something the School is holding,
 * and what is held needs somewhere to be looked at. Issuing one stays on
 * People, beside the Person it is for.
 *
 * Nothing here can show a link. `issueInvitation` returned it once and the API
 * will not say it again, so the only route to a working link for a Person whose
 * link was lost is to revoke the Invitation and issue a fresh one.
 */
export function Invitations({ school }: { school: ReachedSchool }) {
  const { schoolId } = school;
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<Invitation | null>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      const listed = await api.invitations(schoolId);
      if (!current) {
        return;
      }
      if (listed.ok) {
        setState({ kind: "ready", invitations: listed.body.invitations });
      } else if ((await afterFailure()) === "not-available" && current) {
        setState({ kind: "not-available" });
      }
    })();
    return () => {
      current = false;
    };
  }, [schoolId]);

  /**
   * Revokes the Invitation, then lists what is pending afterwards. Nothing is
   * struck off the page before the server says it is gone: a refusal the actor
   * cannot see is indistinguishable from a success, so a row removed
   * optimistically could be a live link still in someone's hands.
   *
   * Where the listing afterwards cannot be had either, the sheet goes to the
   * one not-available state rather than keeping the rows it drew before. A
   * pending list that may be a revocation out of date is worse than no list:
   * it would name a link as live that is not.
   */
  const revoke = async (invitation: Invitation) => {
    setBusy(true);
    const sent = await api.revokeInvitation(schoolId, invitation.id);
    const listed = sent.ok ? await api.invitations(schoolId) : null;
    setBusy(false);
    if (listed?.ok) {
      setState({ kind: "ready", invitations: listed.body.invitations });
    } else if ((await afterFailure()) === "not-available") {
      setState({ kind: "not-available" });
    }
  };

  const legend = (
    <>
      <h2>This sheet</h2>
      <p>Every Invitation this School is still holding open.</p>
      <dl>
        <Key term="Invitation">
          An offer that lets one human claim a Person not yet attached to a User account. It grants no role, and it
          works once.
        </Key>
        <Key term="Expires">
          When the link stops working of its own accord. Until then the Invitation stays listed here.
        </Key>
        <Key term="Revoke">
          Stops the link working before it expires. The Person stays Unclaimed, and a new Invitation can be issued.
        </Key>
      </dl>
    </>
  );

  const people = <Link to={{ name: "persons", schoolId }}>People</Link>;

  const sheet = (invitations: Invitation[]) => (
    <Sheet {...SHEET} legend={legend}>
      <h1>Invitations</h1>
      <RecordList
        label="Pending Invitations"
        rows={invitations}
        keyOf={(invitation) => invitation.id}
        empty={<>No Invitation is pending. Issue one from {people}, beside the Person it is for.</>}
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
      <p className="muted">
        A link is shown once, when the Invitation is issued, and never again. Where one has been lost, revoke the
        Invitation and issue a new one from {people}.
      </p>
      {confirming !== null && (
        <ConfirmDialog
          title="Revoke this Invitation?"
          confirm="Revoke the Invitation"
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const invitation = confirming;
            setConfirming(null);
            void revoke(invitation);
          }}
        >
          <p>
            The link issued for {confirming.person.displayName} stops working, whoever is holding it.{" "}
            {confirming.person.displayName} stays Unclaimed, and nothing else about the Person changes.
          </p>
          <p>To let someone claim this Person after this, issue a new Invitation and hand out the new link.</p>
        </ConfirmDialog>
      )}
    </Sheet>
  );

  switch (state.kind) {
    case "loading":
      return <Sheet {...SHEET} busy />;
    case "not-available":
      return <NotAvailable />;
    case "ready":
      return sheet(state.invitations);
  }
}
