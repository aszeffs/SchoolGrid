import type { FastifyInstance } from "fastify";
import { authorizeReadResultValueScale, authorizeSaveResultValueScale } from "../access/index.ts";
import { appendAuditRecord } from "../audit/index.ts";
import type { Authenticator } from "../authentication/index.ts";
import type { Database } from "../db/pool.ts";
import { withTransaction } from "../db/transaction.ts";
import { Conflict } from "../http/conflict.ts";
import { InvalidRequest } from "../http/invalid-request.ts";
import { fieldsOf, reasonFrom } from "../http/request-body.ts";
import { registerSchoolScope } from "../http/school-scope.ts";
import {
  MAX_RESULT_VALUE_DESCRIPTION_LENGTH,
  MAX_RESULT_VALUE_LABEL_LENGTH,
  MAX_RESULT_VALUES,
} from "../validation/bounds.ts";
import {
  currentResultValueScale,
  holdResultValueScale,
  sameValues,
  saveResultValueScale,
  type ResultValue,
  type ResultValueScale,
} from "./index.ts";

/**
 * Results over HTTP. For now, the School's Result value scale: its current
 * version, read by Faculty and School Administrators, and a new version saved
 * by a School Administrator. Every decision on who may is the Access module's,
 * asked before anything else about the request is looked at.
 */
export function registerResultRoutes(app: FastifyInstance, database: Database, authenticator: Authenticator): void {
  registerSchoolScope(app, database, authenticator, (scope) => {
    scope.get("/result-value-scale", async (actor) => {
      const schoolId = authorizeReadResultValueScale(actor);
      return { resultValueScale: await currentResultValueScale(database, schoolId) };
    });

    // Every save is a new version, whole: the values in their order. One
    // holding exactly what the current version holds would add nothing.
    scope.post("/result-value-scale", async (actor, { body }) => {
      const schoolId = authorizeSaveResultValueScale(actor);
      const fields = fieldsOf(body, ["values", "reason"]);
      const values = resultValuesFrom(fields["values"]);
      const reason = reasonFrom(fields["reason"]);
      return withTransaction(database, async (transaction) => {
        const before = await holdResultValueScale(transaction, schoolId);
        if (sameValues(before.values, values)) {
          throw new Conflict({ conflict: "unchanged" });
        }
        const after = await saveResultValueScale(transaction, {
          schoolId,
          previous: before,
          values,
          savedByPersonId: actor.person.id,
        }).catch((error: unknown) => {
          // The database folds letter case its own way, which can find two
          // labels the same that the check above did not.
          if ((error as { constraint?: unknown } | null)?.constraint === "result_value_label_unique") {
            throw new InvalidRequest("no two values may share a label, whatever their letter case");
          }
          throw error;
        });
        await appendAuditRecord(transaction, {
          schoolId,
          actorPersonId: actor.person.id,
          action: "result_value_scale.saved",
          target: { type: "school", id: schoolId },
          reason,
          before: auditedScale(before),
          after: auditedScale(after),
        });
        return { resultValueScale: after };
      });
    });
  });
}

/**
 * A scale as its Audit record holds it. A record's values are flat, so the
 * values go in as one JSON list, which keeps their order and tells a label
 * from its description whatever either holds.
 */
function auditedScale({ version, values }: ResultValueScale) {
  return { version, values: JSON.stringify(values) };
}

/**
 * The values a save holds, in their order: at least one, at most
 * MAX_RESULT_VALUES, and no two labels the same but for letter case. A label
 * and a description are held to their bounds as given, never trimmed, so what
 * is stored is what was sent.
 */
function resultValuesFrom(value: unknown): ResultValue[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RESULT_VALUES) {
    throw new InvalidRequest(`values must be a list of 1 to ${MAX_RESULT_VALUES} values`);
  }
  const values = value.map((entry: unknown, index) => {
    const fields = fieldsOf(entry, ["label", "description"]);
    return {
      label: unpaddedText(fields["label"], `values[${index}].label`, MAX_RESULT_VALUE_LABEL_LENGTH),
      description:
        fields["description"] === undefined || fields["description"] === null
          ? null
          : unpaddedText(fields["description"], `values[${index}].description`, MAX_RESULT_VALUE_DESCRIPTION_LENGTH),
    };
  });
  const labels = new Set(values.map(({ label }) => label.toLowerCase()));
  if (labels.size !== values.length) {
    throw new InvalidRequest("no two values may share a label, whatever their letter case");
  }
  return values;
}

/** Text that is not blank, carries no surrounding space, and runs to at most `max` characters. */
function unpaddedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || [...value].length > max) {
    throw new InvalidRequest(`${field} must be text of at most ${max} characters, with no surrounding space`);
  }
  return value;
}
