import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { darken, openSchool, openSection, recordRows, schoolIdOf, signIn, stubTrail, type TrailPage } from "./app.ts";
import { seeded } from "./seeded.ts";
import { expect, test } from "./test.ts";

/**
 * The School Administrator's own pages, Audit and School settings, held to the
 * same bar in the dark rendition as the rest of the suite holds them to in the
 * light one (ADR-0010): the trail on either side of a page turn, and the
 * settings both while the timezone can change and once it is fixed.
 */

const RECORD = {
  occurredAt: "2026-09-01T09:30:15.000Z",
  actorPersonId: null,
  actorPlatformAdministratorId: null,
  reason: "no-such-person",
};

/** Two pages of a trail, a refused request's long path among them. */
function trailOf(schoolId: string): Record<string, TrailPage> {
  return {
    first: {
      auditRecords: [
        {
          ...RECORD,
          id: randomUUID(),
          action: "access.refused",
          target: { type: "request", id: `GET /api/schools/${schoolId}/persons/${randomUUID()}` },
        },
      ],
      nextCursor: "00000000-0000-4000-8000-000000000001",
    },
    "00000000-0000-4000-8000-000000000001": {
      auditRecords: [
        { ...RECORD, id: randomUUID(), action: "oldest.one", target: { type: "membership", id: randomUUID() } },
      ],
      nextCursor: null,
    },
  };
}

/** Answers the settings as the server holds them, with the timezone fixed or not as the test needs. */
async function stubTimezoneFixed(page: Page, timezoneFixed: boolean) {
  await page.route("**/api/schools/*/settings", async (route) => {
    const held = (await (await route.fetch()).json()) as { settings: { timezoneFixed: boolean } };
    return route.fulfill({ status: 200, json: { ...held, settings: { ...held.settings, timezoneFixed } } });
  });
}

test("Audit, paged, and School settings stay legible in the dark rendition", async ({ page, audit }) => {
  const { schoolAdministrator, schools } = seeded();
  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[1]!);
  const schoolId = await schoolIdOf(page, schools[1]!);
  await stubTrail(page, trailOf(schoolId));
  await darken(page);

  await openSection(page, "Audit");
  const older = page.getByRole("navigation", { name: "Audit pages" }).getByRole("button", { name: "Older" });
  await expect(recordRows(page, "Audit records").filter({ hasText: "access.refused" })).toHaveCount(1);
  await audit(page);
  await older.click();
  await expect(recordRows(page, "Audit records").filter({ hasText: "oldest.one" })).toHaveCount(1);
  await expect(older).toHaveAttribute("aria-disabled", "true");
  await audit(page);

  for (const timezoneFixed of [false, true]) {
    await page.unrouteAll();
    await stubTimezoneFixed(page, timezoneFixed);
    await page.goto(`/schools/${schoolId}/settings`);
    await expect(
      timezoneFixed
        ? page.getByRole("heading", { level: 2, name: "The timezone is fixed" })
        : page.getByRole("form", { name: "Change the timezone" }),
    ).toBeVisible();
    await audit(page);
  }
});
