import type { FastifyInstance } from "fastify";
import {
  authorizeReadTermResultsOf,
  authorizeRecordTermResults,
  termResultsRecordingRefusal,
  type Actor,
} from "../access/index.ts";
import { findClassOffering, type DescribedClassOffering } from "../academic-structure/courses.ts";
import { appendAuditRecord } from "../audit/index.ts";
import type { Authenticator } from "../authentication/index.ts";
import type { Database } from "../db/pool.ts";
import { withTransaction, type Queryable } from "../db/transaction.ts";
import { InvalidRequest } from "../http/invalid-request.ts";
import { fieldsOf } from "../http/request-body.ts";
import { registerSchoolScope } from "../http/school-scope.ts";
import { findPersons } from "../identity/index.ts";
import {
  MAX_RESULT_VALUE_LABEL_LENGTH,
  MAX_TERM_RESULT_COMMENT_LENGTH,
  MAX_TERM_RESULT_SCORE,
} from "../validation/bounds.ts";
import { currentResultValueScale } from "./index.ts";
import {
  changeTermResult,
  currentResultValueIds,
  holdTermResults,
  NO_CONTENT,
  recordTermResult,
  rosteredIn,
  sameContent,
  termResultsIn,
  type OfferingKey,
  type TermResult,
  type TermResultContent,
} from "./term-results.ts";

/**
 * The most drafts one save carries. A class of any real size fits well inside
 * it; the bound is there so one request cannot hold the offering's results
 * over an unbounded list.
 */
const MAX_DRAFTS_AT_ONCE = 200;

/** One Student's draft in a save: what the caller loaded, and what it should now say. */
interface Draft extends TermResultContent {
  studentPersonId: string;
  loaded: TermResultContent | null;
}

/** Why one draft of a save was not applied. */
type DraftRefusal = "stale" | "value_not_in_scale";

/** Someone named on a result, by display name alone. */
interface Named {
  id: string;
  displayName: string;
}

// Validation below runs only once the Access decision has permitted the
// caller: see InvalidRequest.

function parseDrafts(body: unknown): Draft[] {
  const drafts = fieldsOf(body, ["drafts"])["drafts"];
  if (!Array.isArray(drafts) || drafts.length > MAX_DRAFTS_AT_ONCE) {
    throw new InvalidRequest(`drafts must be a list of at most ${MAX_DRAFTS_AT_ONCE} drafts`);
  }
  const parsed = drafts.map((draft: unknown): Draft => {
    const fields = fieldsOf(draft, ["studentPersonId", "loaded", "value", "score", "comment"]);
    const { studentPersonId, loaded } = fields;
    if (typeof studentPersonId !== "string" || studentPersonId.length === 0) {
      throw new InvalidRequest("each draft's studentPersonId must name a Student");
    }
    return { studentPersonId, loaded: loaded === null ? null : loadedFrom(loaded), ...contentFrom(fields) };
  });
  if (new Set(parsed.map((draft) => draft.studentPersonId)).size !== parsed.length) {
    throw new InvalidRequest("drafts must name each Student once");
  }
  return parsed;
}

/**
 * What a draft should now say, each part given, null for none. A value is
 * held to the scale's label bound here and to the current scale when it is
 * applied; a score to 0 to 100 with at most one decimal; a comment to its
 * length, and not blank.
 */
function contentFrom(fields: Record<string, unknown>): TermResultContent {
  const { value, score, comment } = fields;
  if (value !== null && (typeof value !== "string" || value.length === 0 || [...value].length > MAX_RESULT_VALUE_LABEL_LENGTH)) {
    throw new InvalidRequest("each draft's value must be a label of the Result value scale, or null");
  }
  if (
    score !== null &&
    (typeof score !== "number" ||
      !(score >= 0 && score <= MAX_TERM_RESULT_SCORE) ||
      Math.abs(score * 10 - Math.round(score * 10)) > 1e-9)
  ) {
    throw new InvalidRequest(`each draft's score must be a number from 0 to ${MAX_TERM_RESULT_SCORE} with at most one decimal, or null`);
  }
  if (
    comment !== null &&
    (typeof comment !== "string" || comment.trim().length === 0 || [...comment].length > MAX_TERM_RESULT_COMMENT_LENGTH)
  ) {
    throw new InvalidRequest(`each draft's comment must be text of at most ${MAX_TERM_RESULT_COMMENT_LENGTH} characters, or null`);
  }
  // Rounded to the one decimal kept, so 87.3 is stored as 87.3 however the number arrived.
  return { value, score: score === null ? null : Math.round(score * 10) / 10, comment } as TermResultContent;
}

/** The content a draft carries as loaded: only compared, so only its shape is held to. */
function loadedFrom(loaded: unknown): TermResultContent {
  const { value, score, comment } = fieldsOf(loaded, ["value", "score", "comment"]);
  if (
    (value !== null && typeof value !== "string") ||
    (score !== null && typeof score !== "number") ||
    (comment !== null && typeof comment !== "string")
  ) {
    throw new InvalidRequest("each draft's loaded content must hold a value, score and comment, each possibly null");
  }
  return { value, score, comment };
}

function contentOf(result: TermResult | null): TermResultContent {
  return result === null ? NO_CONTENT : { value: result.value, score: result.score, comment: result.comment };
}

function serveTermResult(result: TermResult, named: (id: string) => Named) {
  return {
    ...contentOf(result),
    scaleVersion: result.scaleVersion,
    recordedBy: named(result.recordedByPersonId),
    recordedAt: result.recordedAt.toISOString(),
  };
}

/** By the Student's display name, and by identifier between two of one name. */
function byName(a: { person: Named }, b: { person: Named }): number {
  return a.person.displayName.localeCompare(b.person.displayName) || a.person.id.localeCompare(b.person.id);
}

/**
 * The offering's results as the actor is served them: why they are read-only
 * for them if they are, the scale a value is chosen from, and every Student
 * ever rostered in it, a withdrawn one too, with their result if they have one.
 */
async function serveOfferingResults(database: Queryable, actor: Actor, offering: DescribedClassOffering) {
  const key: OfferingKey = { schoolId: offering.schoolId, classOfferingId: offering.id };
  const rostered = await rosteredIn(database, key);
  const results = await termResultsIn(database, key);
  const persons = await findPersons(database, [
    ...rostered.keys(),
    ...results.flatMap((result) => [result.studentPersonId, result.recordedByPersonId]),
  ]);
  const named = (id: string): Named => ({ id, displayName: persons.get(id)?.displayName ?? "" });
  const resultOf = new Map(results.map((result) => [result.studentPersonId, result]));
  return {
    classOfferingId: offering.id,
    readOnlyBecause: await termResultsRecordingRefusal(database, actor, offering),
    resultValueScale: await currentResultValueScale(database, offering.schoolId),
    students: [...new Set([...rostered.keys(), ...resultOf.keys()])]
      .map((id) => {
        const result = resultOf.get(id);
        return {
          person: named(id),
          rosterMemberships: rostered.get(id) ?? [],
          termResult: result === undefined ? null : serveTermResult(result, named),
        };
      })
      .sort(byName),
  };
}

/** A result as its Audit record holds it. */
function auditedResult(result: TermResult, classOfferingId: string) {
  return {
    studentPersonId: result.studentPersonId,
    classOfferingId,
    value: result.value,
    scaleVersion: result.scaleVersion,
    score: result.score,
    comment: result.comment,
  };
}

/**
 * Draft Term results, one Class Offering at a time (CONTEXT.md: Term result).
 *
 * Reading them is for anyone who may read the offering's results: a School
 * Administrator, or Faculty ever assigned to it. Saving drafts is for a Faculty
 * member whose Teaching assignment for it is active now. Every decision on who
 * may is the Access module's, asked before anything else about the request is
 * looked at.
 */
export function registerTermResultRoutes(app: FastifyInstance, database: Database, authenticator: Authenticator): void {
  registerSchoolScope(app, database, authenticator, (scope) => {
    const readableOffering = async (actor: Actor, classOfferingId: string) =>
      authorizeReadTermResultsOf(actor, classOfferingId, await findClassOffering(database, classOfferingId));

    scope.get("/class-offerings/:classOfferingId/term-results", async (actor, { params }) => {
      const offering = await readableOffering(actor, params["classOfferingId"]!);
      return { classOfferingResults: await serveOfferingResults(database, actor, offering) };
    });

    // Saves drafts, each carrying the content the caller loaded. A draft whose
    // stored content differs is refused with its current content, as is one
    // whose new value the current scale does not hold, and the rest still
    // apply. A changed value is bound to the current scale version; a value
    // left as it was keeps its own.
    scope.patch("/class-offerings/:classOfferingId/term-results", async (actor, { params, body }) => {
      const readable = await readableOffering(actor, params["classOfferingId"]!);
      return withTransaction(database, async (transaction) => {
        const offering = await authorizeRecordTermResults(transaction, actor, readable);
        const drafts = parseDrafts(body);
        const key: OfferingKey = { schoolId: offering.schoolId, classOfferingId: offering.id };
        const stored = new Map((await holdTermResults(transaction, key)).map((result) => [result.studentPersonId, result]));
        const rostered = await rosteredIn(transaction, key);
        if (drafts.some((draft) => !rostered.has(draft.studentPersonId))) {
          throw new InvalidRequest("drafts must name Students rostered in the Class Offering");
        }
        const currentValues = await currentResultValueIds(transaction, offering.schoolId);
        const refused: { studentPersonId: string; because: DraftRefusal; current: TermResult | null }[] = [];
        for (const { studentPersonId, loaded, ...content } of drafts) {
          const current = stored.get(studentPersonId) ?? null;
          const refuse = (because: DraftRefusal) => refused.push({ studentPersonId, because, current });
          const held = contentOf(current);
          if (!sameContent(held, loaded ?? NO_CONTENT)) {
            refuse("stale");
            continue;
          }
          if (sameContent(held, content)) {
            continue;
          }
          const valueChanged = content.value !== held.value;
          if (valueChanged && content.value !== null && !currentValues.has(content.value)) {
            refuse("value_not_in_scale");
            continue;
          }
          const recording = {
            resultValueId: !valueChanged ? (current?.resultValueId ?? null) : content.value === null ? null : currentValues.get(content.value)!,
            score: content.score,
            comment: content.comment,
            recordedByPersonId: actor.person.id,
          };
          if (current === null) {
            stored.set(studentPersonId, await recordTermResult(transaction, { ...key, studentPersonId, ...recording }));
            continue;
          }
          const changed = await changeTermResult(transaction, current, recording);
          await appendAuditRecord(transaction, {
            schoolId: offering.schoolId,
            actorPersonId: actor.person.id,
            action: "term_result.changed",
            target: { type: "term_result", id: current.id },
            reason: null,
            before: auditedResult(current, offering.id),
            after: auditedResult(changed, offering.id),
          });
        }
        const served = await serveOfferingResults(transaction, actor, offering);
        const persons = await findPersons(
          transaction,
          refused.flatMap(({ current }) => (current === null ? [] : [current.recordedByPersonId])),
        );
        const named = (id: string): Named => ({ id, displayName: persons.get(id)?.displayName ?? "" });
        return {
          classOfferingResults: served,
          refusedDrafts: refused.map(({ studentPersonId, because, current }) => ({
            studentPersonId,
            because,
            termResult: current === null ? null : serveTermResult(current, named),
          })),
        };
      });
    });
  });
}
