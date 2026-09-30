import { useState } from "react";
import { MAX_REASON_LENGTH } from "../../src/validation/bounds.ts";
import {
  api,
  type ApiResult,
  type CorrectionDecision,
  type CorrectionRequest,
  type PublishedContent,
  type ReachedSchool,
} from "./api.ts";
import { statusOrNone } from "./attendance.ts";
import { contentText, correctionConflictMessage, partText, RESULT_PARTS } from "./corrections.ts";
import { ConfirmDialog } from "./Dialog.tsx";
import { Link } from "./Link.tsx";
import { NotAvailable } from "./NotAvailable.tsx";
import { offeringName } from "./offerings.ts";
import { RecordList, type Column } from "./RecordList.tsx";
import { useScreen } from "./screen.ts";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";
import { formatSchoolDate, MOMENT } from "./standing.ts";

/** Which sheet this page is, named once so its states cannot drift apart. */
const SHEET: SheetKind = { name: "Correction requests" };

const STATE_NAMES = { pending: "Pending", approved: "Approved", rejected: "Rejected", withdrawn: "Withdrawn" } as const;

/**
 * Correction requests: a School Administrator's queue of every one in the
 * School, Pending first and oldest first, each approved or rejected here; and
 * for anyone else who raises them, their own, each withdrawn here while it is
 * Pending. Which of the two the page is, the server says by what it lists.
 *
 * A request is raised from an Attendance session, or from a class's Term
 * results, beside the Student it is for. An Attendance request shows the
 * status before and after; a Term result request, each of the value, score
 * and comment before and after. Anyone the server refuses sees the one "not
 * available" state (ADR-0002).
 */
export function CorrectionRequests({ school }: { school: ReachedSchool }) {
  const { schoolId } = school;
  const { showing, busy, change } = useScreen(schoolId, api.correctionRequests);

  switch (showing.kind) {
    case "loading":
      return <Sheet {...SHEET} busy />;
    case "not-available":
      return <NotAvailable />;
    case "ready":
      return (
        <RequestsSheet
          schoolId={schoolId}
          personId={school.personId}
          administers={school.roles.includes("school_administrator")}
          requests={showing.records.correctionRequests}
          busy={busy}
          onDecide={(request, decision) => change(() => api.decideCorrectionRequest(schoolId, request.id, decision))}
        />
      );
  }
}

/** What the reader is about to do to which request, while its confirmation is open. */
type Deciding = { request: CorrectionRequest; state: CorrectionDecision["state"] };

function RequestsSheet({
  schoolId,
  personId,
  administers,
  requests,
  busy,
  onDecide,
}: {
  schoolId: string;
  personId: string;
  administers: boolean;
  requests: CorrectionRequest[];
  busy: boolean;
  onDecide: (request: CorrectionRequest, decision: CorrectionDecision) => Promise<ApiResult<unknown>>;
}) {
  const [deciding, setDeciding] = useState<Deciding | null>(null);
  const [done, setDone] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const pending = requests.filter((request) => request.state === "pending");
  const decided = requests.filter((request) => request.state !== "pending");

  const decide = async (request: CorrectionRequest, decision: CorrectionDecision) => {
    setDeciding(null);
    setDone("");
    setProblem(null);
    const sent = await onDecide(request, decision);
    if (sent.ok) {
      setDone(`${request.student.displayName}’s request is ${STATE_NAMES[decision.state].toLowerCase()}.`);
    } else if (sent.conflict !== undefined) {
      setProblem(correctionConflictMessage(sent.conflict, request.kind));
    }
  };

  const described: Column<CorrectionRequest>[] = [
    { head: "Student", cell: (request) => request.student.displayName },
    {
      head: "Class",
      cell: (request) =>
        request.kind === "attendance" ? (
          <Link to={{ name: "attendanceOn", schoolId, classOfferingId: request.classOffering.id, date: request.date }}>
            {offeringName(request.classOffering)}, {formatSchoolDate(request.date)}
          </Link>
        ) : (
          <Link to={{ name: "termResults", schoolId, classOfferingId: request.classOffering.id }}>
            {offeringName(request.classOffering)}, Term result
          </Link>
        ),
    },
    {
      head: "Change",
      cell: (request) =>
        request.kind === "attendance" ? (
          `${statusOrNone(request.before)} to ${statusOrNone(request.after)}`
        ) : (
          <ResultChange before={request.before} after={request.after} />
        ),
    },
    { head: "Reason", cell: (request) => request.reason },
    {
      head: "Requested",
      cell: (request) => `${request.requestedBy.displayName}, ${MOMENT.format(new Date(request.raisedAt))}`,
    },
  ];

  const legend = (
    <>
      <h2>Key</h2>
      <p>
        {administers
          ? "Every Correction request in the School, waiting ones first."
          : "The Correction requests you raised, waiting ones first."}
      </p>
      <dl>
        <Key term="Correction request">
          A proposed change, with a reason: to one Student’s Attendance on one date, after its Attendance window has
          closed, to settle an Absent, pending review, or to add a mark nobody recorded; or to one Student’s published
          Term result.
        </Key>
        <Key term="Pending">Waiting for a School Administrator other than the one who raised it.</Key>
        <Key term="Approved">The change is made, the moment it is approved.</Key>
        <Key term="Rejected">Turned down, with a reason. The Attendance or result stays as it was.</Key>
        <Key term="Withdrawn">Taken back by whoever raised it.</Key>
        <Key term="Self-approved">
          Approved by whoever raised it, as the School’s only School Administrator. The Audit record says so.
        </Key>
      </dl>
    </>
  );

  return (
    <Sheet {...SHEET} legend={legend}>
      <h1>Correction requests</h1>
      <p className="muted">
        A request is raised from a class’s Attendance session or its Term results, beside the Student it is for.
        {administers ? " A request you raised is decided by another School Administrator, if the School has one." : ""}
      </p>

      <section>
        <h2>Pending</h2>
        <RecordList
          label="Pending Correction requests"
          rows={pending}
          keyOf={(request) => request.id}
          empty="No Correction request is waiting."
          columns={[
            ...described,
            {
              head: "Decide",
              actions: true,
              cell: (request) => {
                const whose = `${request.student.displayName}’s request`;
                return (
                  <>
                    {administers && (
                      <>
                        <button
                          type="button"
                          className="button-stamp"
                          disabled={busy}
                          aria-label={`Approve ${whose}`}
                          onClick={() => setDeciding({ request, state: "approved" })}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="button-quiet"
                          disabled={busy}
                          aria-label={`Reject ${whose}`}
                          onClick={() => setDeciding({ request, state: "rejected" })}
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {request.requestedBy.id === personId && (
                      <button
                        type="button"
                        className="button-quiet"
                        disabled={busy}
                        aria-label={`Withdraw ${whose}`}
                        onClick={() => setDeciding({ request, state: "withdrawn" })}
                      >
                        Withdraw
                      </button>
                    )}
                  </>
                );
              },
            },
          ]}
        />
      </section>

      {problem !== null && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <p className="muted" role="status">
        {done}
      </p>

      <section>
        <h2>Decided</h2>
        <RecordList
          label="Decided Correction requests"
          rows={decided}
          keyOf={(request) => request.id}
          empty="No Correction request has been decided yet."
          columns={[
            ...described,
            {
              head: "Decision",
              cell: (request) => (
                <>
                  <span className={request.state === "approved" ? "mark mark--filled" : "mark mark--struck"}>
                    {STATE_NAMES[request.state]}
                  </span>{" "}
                  {request.selfApproved && <span className="mark mark--open">Self-approved</span>}
                  <br />
                  {request.decidedBy?.displayName}, {MOMENT.format(new Date(request.decidedAt!))}
                  {request.rejectionReason !== null && (
                    <>
                      <br />
                      {request.rejectionReason}
                    </>
                  )}
                </>
              ),
            },
          ]}
        />
      </section>

      {deciding !== null && (
        <Decide
          deciding={deciding}
          own={deciding.request.requestedBy.id === personId}
          busy={busy}
          onCancel={() => setDeciding(null)}
          onDecide={(decision) => void decide(deciding.request, decision)}
        />
      )}
    </Sheet>
  );
}

/** The confirmation for one decision, naming the change it makes, or does not; a rejection asks why. */
function Decide({
  deciding: { request, state },
  own,
  busy,
  onCancel,
  onDecide,
}: {
  deciding: Deciding;
  own: boolean;
  busy: boolean;
  onCancel: () => void;
  onDecide: (decision: CorrectionDecision) => void;
}) {
  const [reason, setReason] = useState("");
  const student = request.student.displayName;
  const offering = offeringName(request.classOffering);
  const { change, from, to } =
    request.kind === "attendance"
      ? {
          change: `${student}’s Attendance in ${offering} on ${formatSchoolDate(request.date)}`,
          from: statusOrNone(request.before),
          to: statusOrNone(request.after),
        }
      : {
          change: `${student}’s Term result in ${offering}`,
          from: contentText(request.before),
          to: contentText(request.after),
        };
  const record = request.kind === "attendance" ? "Attendance" : "result";

  switch (state) {
    case "approved":
      return (
        <ConfirmDialog
          title={`Approve ${student}’s correction?`}
          confirm="Approve"
          busy={busy}
          onCancel={onCancel}
          onConfirm={() => onDecide({ state })}
        >
          <p>
            {change} changes from {from} to {to} at once.
          </p>
          <p>Reason given: {request.reason}</p>
          {own && (
            <p>
              You raised this request. You may approve it only as the School’s only School Administrator, and the Audit
              record will say it was self-approved.
            </p>
          )}
        </ConfirmDialog>
      );
    case "rejected":
      return (
        <ConfirmDialog
          title={`Reject ${student}’s correction?`}
          confirm="Reject"
          busy={busy || reason.trim() === ""}
          onCancel={onCancel}
          onConfirm={() => onDecide({ state, reason })}
        >
          <p>
            {change} stays {from}. {request.requestedBy.displayName} sees the reason you give.
          </p>
          <label>
            Reason
            <input
              name="reason"
              required
              maxLength={MAX_REASON_LENGTH}
              autoComplete="off"
              value={reason}
              onChange={(event) => setReason(event.currentTarget.value)}
            />
          </label>
        </ConfirmDialog>
      );
    case "withdrawn":
      return (
        <ConfirmDialog
          title="Withdraw your correction?"
          confirm="Withdraw"
          busy={busy}
          onCancel={onCancel}
          onConfirm={() => onDecide({ state })}
        >
          <p>
            The request to change {change} from {from} to {to} is taken back. Nothing about the {record} changes.
          </p>
        </ConfirmDialog>
      );
  }
}

/** A result correction's parts side by side: each before and after, an unchanged one said so. */
function ResultChange({ before, after }: { before: PublishedContent; after: PublishedContent }) {
  return (
    <dl className="correction-change">
      {RESULT_PARTS.map(({ part, name }) => (
        <div key={part}>
          <dt>{name}</dt>
          <dd className={before[part] === after[part] ? "muted" : undefined}>
            {before[part] === after[part]
              ? `${partText(before, part)}, unchanged`
              : `${partText(before, part)} to ${partText(after, part)}`}
          </dd>
        </div>
      ))}
    </dl>
  );
}
