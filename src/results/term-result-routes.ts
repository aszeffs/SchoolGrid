import type { FastifyInstance } from "fastify";
import {
  authorizePublishTermResults,
  authorizeReadTermResultsOf,
  authorizeRecordTermResults,
  mayPublishTermResults,
  mayRaiseCorrectionRequest,
  termResultsRecordingRefusal,
  type Actor,
} from "../access/index.ts";
import { findClassOffering, type DescribedClassOffering } from "../academic-structure/courses.ts";
import { appendAuditRecord } from "../audit/index.ts";
import type { Authenticator } from "../authentication/index.ts";
import type { Database } from "../db/pool.ts";
import { withTransaction, type Queryable } from "../db/transaction.ts";
import { Conflict } from "../http/conflict.ts";
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
  leftOn,
  NO_CONTENT,
  publishTermResults,
  recordTermResult,
  rosteredIn,
  sameContent,
  termResultsIn,
  type DraftRefusal,
  type OfferingKey,
  type RosteredBounds,
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
    return { studentPersonId, loaded: loaded === null ? null : loadedFrom(loaded), ...termResultContentFrom(fields) };
  });
  if (new Set(parsed.map((draft) => draft.studentPersonId)).size !== parsed.length) {
    throw new InvalidRequest("drafts must name each Student once");
  }
  return parsed;
}

/**
 * What a result should now say, each part given, null for none: `whose` names
 * it in a refusal. A value is held to the scale's label bound here and to the
 * current scale when it is applied; a score to 0 to 100 with at most one
 * decimal; a comment to its length, and not blank.
 */
export function termResultContentFrom(fields: Record<string, unknown>, whose = "each draft's"): TermResultContent {
  const { value, score, comment } = fields;
  if (value !== null && (typeof value !== "string" || value.length === 0 || [...value].length > MAX_RESULT_VALUE_LABEL_LENGTH)) {
    throw new InvalidRequest(`${whose} value must be a label of the Result value scale, or null`);
  }
  if (
    score !== null &&
    (typeof score !== "number" ||
      !(score >= 0 && score <= MAX_TERM_RESULT_SCORE) ||
      Math.abs(score * 10 - Math.round(score * 10)) > 1e-9)
  ) {
    throw new InvalidRequest(`${whose} score must be a number from 0 to ${MAX_TERM_RESULT_SCORE} with at most one decimal, or null`);
  }
  if (
    comment !== null &&
    (typeof comment !== "string" || comment.trim().length === 0 || [...comment].length > MAX_TERM_RESULT_COMMENT_LENGTH)
  ) {
    throw new InvalidRequest(`${whose} comment must be text of at most ${MAX_TERM_RESULT_COMMENT_LENGTH} characters, or null`);
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
    publishedAt: result.publishedAt?.toISOString() ?? null,
  };
}

/** By display name, and by identifier between two of one name. */
function byName(a: Named, b: Named): number {
  return a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id);
}

/** Names each Person by the display name found for them. */
function namerOf(persons: ReadonlyMap<string, { displayName: string }>): (id: string) => Named {
  return (id) => ({ id, displayName: persons.get(id)?.displayName ?? "" });
}

/**
 * What a Publication of the offering would now do (CONTEXT.md: Publication):
 * the unpublished results carrying a value it would publish, and the active
 * roster members without a value it waits on. One who left the roster, or was
 * never on it, is not waited on.
 */
function publicationOutlook(
  rostered: ReadonlyMap<string, RosteredBounds[]>,
  results: readonly TermResult[],
  termLastDate: string,
) {
  const valued = new Set(results.filter((result) => result.value !== null).map((result) => result.studentPersonId));
  return {
    ready: results.filter((result) => result.value !== null && result.publishedAt === null),
    missingValue: [...rostered]
      .filter(([id, memberships]) => !valued.has(id) && leftOn(memberships, termLastDate) === null)
      .map(([id]) => id),
  };
}

/**
 * The offering's results as the actor is served them: why they are read-only
 * for them if they are, whether they may publish them and what a Publication
 * would now do, whether they may request a correction to a published one, the
 * scale a value is chosen from, and every Student ever rostered in it, a
 * withdrawn one too, with their result if they have one.
 */
async function serveOfferingResults(database: Queryable, actor: Actor, offering: DescribedClassOffering) {
  const key: OfferingKey = { schoolId: offering.schoolId, classOfferingId: offering.id };
  const rostered = await rosteredIn(database, key);
  const results = await termResultsIn(database, key);
  const persons = await findPersons(database, [
    ...rostered.keys(),
    ...results.flatMap((result) => [result.studentPersonId, result.recordedByPersonId]),
  ]);
  const named = namerOf(persons);
  const resultOf = new Map(results.map((result) => [result.studentPersonId, result]));
  const outlook = publicationOutlook(rostered, results, offering.term.lastDate);
  return {
    classOfferingId: offering.id,
    readOnlyBecause: await termResultsRecordingRefusal(database, actor, offering),
    mayRequestCorrections: await mayRaiseCorrectionRequest(database, actor, offering),
    publication: {
      mayPublish: await mayPublishTermResults(database, actor, offering),
      missingValue: outlook.missingValue.map(named).sort(byName),
      ready: outlook.ready.length,
    },
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
      .sort((a, b) => byName(a.person, b.person)),
  };
}

/** The row a changed value binds to: its label's in the current scale version, which the caller has checked holds it. */
function boundValueId(value: string | null, currentValues: ReadonlyMap<string, string>): string | null {
  return value === null ? null : currentValues.get(value)!;
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

/** Writes the Audit record of a change to a result in a Class Offering, made by the actor, for a reason if one was given. */
export async function recordResultChange(
  transaction: Queryable,
  actor: Actor,
  classOfferingId: string,
  before: TermResult,
  after: TermResult,
  reason: string | null = null,
): Promise<void> {
  await appendAuditRecord(transaction, {
    schoolId: actor.schoolId,
    actorPersonId: actor.person.id,
    action: "term_result.changed",
    target: { type: "term_result", id: before.id },
    reason,
    before: auditedResult(before, classOfferingId),
    after: auditedResult(after, classOfferingId),
  });
}

/**
 * Term results, one Class Offering at a time (CONTEXT.md: Term result,
 * Publication).
 *
 * Reading them is for anyone who may read the offering's results: a School
 * Administrator, or Faculty ever assigned to it. Saving drafts is for a Faculty
 * member whose Teaching assignment for it is active now, and publishing them
 * for such a Faculty member or a School Administrator. Every decision on who
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
          if (sameContent(held, content) && sameContent(held, loaded ?? NO_CONTENT)) {
            continue;
          }
          if (current?.publishedAt != null) {
            refuse("published");
            continue;
          }
          if (!sameContent(held, loaded ?? NO_CONTENT)) {
            refuse("stale");
            continue;
          }
          const valueChanged = content.value !== held.value;
          if (valueChanged && content.value !== null && !currentValues.has(content.value)) {
            refuse("value_not_in_scale");
            continue;
          }
          const recording = {
            resultValueId: valueChanged ? boundValueId(content.value, currentValues) : (current?.resultValueId ?? null),
            score: content.score,
            comment: content.comment,
            recordedByPersonId: actor.person.id,
          };
          if (current === null) {
            stored.set(studentPersonId, await recordTermResult(transaction, { ...key, studentPersonId, ...recording }));
            continue;
          }
          await recordResultChange(transaction, actor, offering.id, current, await changeTermResult(transaction, current, recording));
        }
        const served = await serveOfferingResults(transaction, actor, offering);
        const persons = await findPersons(
          transaction,
          refused.flatMap(({ current }) => (current === null ? [] : [current.recordedByPersonId])),
        );
        const named = namerOf(persons);
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

    // Publishes every unpublished result carrying a value, at once, as one
    // Publication. Refused, naming each, while an active roster member has no
    // value, and refused with nothing new to publish. What is already
    // published is left as it is.
    scope.post("/class-offerings/:classOfferingId/publications", async (actor, { params }) => {
      const readable = await readableOffering(actor, params["classOfferingId"]!);
      return withTransaction(database, async (transaction) => {
        const offering = await authorizePublishTermResults(transaction, actor, readable);
        const key: OfferingKey = { schoolId: offering.schoolId, classOfferingId: offering.id };
        const results = await holdTermResults(transaction, key);
        const { ready, missingValue } = publicationOutlook(await rosteredIn(transaction, key), results, offering.term.lastDate);
        if (missingValue.length > 0) {
          const persons = await findPersons(transaction, missingValue);
          throw new Conflict({
            conflict: "values_missing",
            students: missingValue.map(namerOf(persons)).sort(byName),
          });
        }
        if (ready.length === 0) {
          throw new Conflict({ conflict: "nothing_to_publish" });
        }
        const publication = await publishTermResults(transaction, key, actor.person.id, ready);
        await appendAuditRecord(transaction, {
          schoolId: offering.schoolId,
          actorPersonId: actor.person.id,
          action: "publication.recorded",
          target: { type: "publication", id: publication.id },
          reason: null,
          before: null,
          after: { classOfferingId: offering.id, resultCount: publication.resultCount },
        });
        return {
          publication: {
            id: publication.id,
            publishedAt: publication.publishedAt.toISOString(),
            publishedBy: { id: actor.person.id, displayName: actor.person.displayName },
            resultCount: publication.resultCount,
          },
          classOfferingResults: await serveOfferingResults(transaction, actor, offering),
        };
      });
    });
  });
}
