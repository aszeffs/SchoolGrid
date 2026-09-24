import { authorizeManageSchoolSettings } from "../access/index.ts";
import { appendAuditRecord } from "../audit/index.ts";
import { offeredTimezones } from "../calendar/index.ts";
import type { Database } from "../db/pool.ts";
import { withTransaction } from "../db/transaction.ts";
import { Conflict } from "../http/conflict.ts";
import { fieldsOf, reasonFrom, timezoneFrom } from "../http/request-body.ts";
import type { SchoolScope } from "../http/school-scope.ts";
import { lockSchoolSettings, schoolSettingsOf, setSchoolTimezone } from "./index.ts";

/**
 * A School's settings, read and changed by its School Administrator. For now
 * they are its timezone alone, which fixes where each School date begins and
 * ends; a School Administrator may correct it until the School's first
 * Academic Year exists (ADR-0011), and is told once it can no longer change.
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

  scope.patch("/settings", async (actor, { body }) => {
    const schoolId = authorizeManageSchoolSettings(actor);
    const fields = fieldsOf(body, ["timezone", "reason"]);
    const timezone = await timezoneFrom(database, fields["timezone"]);
    const reason = reasonFrom(fields["reason"]);
    return withTransaction(database, async (transaction) => {
      const before = (await lockSchoolSettings(transaction, schoolId))!;
      // Stating the timezone the School already has changes nothing, so nothing is recorded.
      if (before.timezone === timezone) {
        return { settings: before };
      }
      // The School row is locked, and creating an Academic Year fixes the
      // timezone by updating it, so none can be created between this and the
      // change.
      if (before.timezoneFixed) {
        throw new Conflict({ conflict: "timezone_fixed" });
      }
      const after = await setSchoolTimezone(transaction, { schoolId, timezone });
      await appendAuditRecord(transaction, {
        schoolId,
        actorPersonId: actor.person.id,
        action: "school.settings_changed",
        target: { type: "school", id: schoolId },
        reason,
        before: { timezone: before.timezone },
        after: { timezone: after.timezone },
      });
      return { settings: after };
    });
  });
}
