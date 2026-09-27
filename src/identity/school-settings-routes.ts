import { authorizeManageSchoolSettings } from "../access/index.ts";
import { attendanceWindowChange } from "../attendance/index.ts";
import { appendAuditRecord } from "../audit/index.ts";
import { offeredTimezones } from "../calendar/index.ts";
import type { Database } from "../db/pool.ts";
import { transactionTime, withTransaction } from "../db/transaction.ts";
import { Conflict } from "../http/conflict.ts";
import { InvalidRequest } from "../http/invalid-request.ts";
import {
  attendanceWindowFrom,
  attendanceWindowFromQuery,
  fieldsOf,
  reasonFrom,
  timezoneFrom,
} from "../http/request-body.ts";
import type { SchoolScope } from "../http/school-scope.ts";
import { lockSchoolSettings, schoolSettingsOf, setSchoolSettings, type ChangeableSchoolSettings } from "./index.ts";

/**
 * A School's settings, read and changed by its School Administrator: its
 * timezone, which fixes where each School date begins and ends, and its
 * Attendance window. The timezone may be corrected until the School's first
 * Academic Year exists (ADR-0011), and the page is told once it can no longer
 * change; the window may change at any time.
 */
export function registerSchoolSettingsRoutes(scope: SchoolScope, database: Database): void {
  // With the timezones worth offering, so a page choosing one offers only what
  // the database would accept, and whether it may still be changed at all.
  scope.get("/settings", async (actor) => {
    const schoolId = authorizeManageSchoolSettings(actor);
    // The actor's own School, so it exists.
    const settings = (await schoolSettingsOf(database, schoolId))!;
    return { settings, timezones: await offeredTimezones(database) };
  });

  // What changing the Attendance window to this many days would open or
  // close, so a page can say so before the change is confirmed.
  scope.get("/settings/attendance-window-preview", async (actor, { query }) => {
    const schoolId = authorizeManageSchoolSettings(actor);
    const to = attendanceWindowFromQuery(query["attendanceWindow"], "attendanceWindow");
    const { attendanceWindow: from } = (await schoolSettingsOf(database, schoolId))!;
    return attendanceWindowChange(database, { schoolId, at: await transactionTime(database), from, to });
  });

  // Either setting, or both; each one given as the School already has it is
  // left out of the Audit record, and a change of neither records nothing.
  scope.patch("/settings", async (actor, { body }) => {
    const schoolId = authorizeManageSchoolSettings(actor);
    const fields = fieldsOf(body, ["timezone", "attendanceWindow", "reason"]);
    if (fields["timezone"] === undefined && fields["attendanceWindow"] === undefined) {
      throw new InvalidRequest("a timezone or an attendanceWindow is required");
    }
    const requested: Partial<ChangeableSchoolSettings> = {};
    if (fields["timezone"] !== undefined) {
      requested.timezone = await timezoneFrom(database, fields["timezone"]);
    }
    if (fields["attendanceWindow"] !== undefined) {
      requested.attendanceWindow = attendanceWindowFrom(fields["attendanceWindow"], "attendanceWindow");
    }
    const reason = reasonFrom(fields["reason"]);
    return withTransaction(database, async (transaction) => {
      const before = (await lockSchoolSettings(transaction, schoolId))!;
      const changes = (Object.keys(requested) as (keyof ChangeableSchoolSettings)[]).filter(
        (setting) => requested[setting] !== before[setting],
      );
      if (changes.length === 0) {
        return { settings: before };
      }
      // The School row is locked, and creating an Academic Year fixes the
      // timezone by updating it, so none can be created between this and the
      // change.
      if (changes.includes("timezone") && before.timezoneFixed) {
        throw new Conflict({ conflict: "timezone_fixed" });
      }
      const after = await setSchoolSettings(transaction, schoolId, requested);
      await appendAuditRecord(transaction, {
        schoolId,
        actorPersonId: actor.person.id,
        action: "school.settings_changed",
        target: { type: "school", id: schoolId },
        reason,
        before: Object.fromEntries(changes.map((setting) => [setting, before[setting]])),
        after: Object.fromEntries(changes.map((setting) => [setting, after[setting]])),
      });
      return { settings: after };
    });
  });
}
