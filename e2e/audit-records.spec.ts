import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { arrangePerson, openSchool, openSection, recordRows, schoolIdOf, signIn } from "./app.ts";
import { seeded } from "./seeded.ts";
import { expect, expectNoSidewaysScroll, test } from "./test.ts";

/**
 * Audit: a School's trail, read a page at a time. What is asserted is that
 * the sheet names who acted and on what without showing anything the record
 * does not carry, and that it pages forward and back by the cursor each page
 * hands it, never asking for the whole trail (ADR-0008).
 */

const rows = (page: Page) => recordRows(page, "Audit records");
const pager = (page: Page) => page.getByRole("navigation", { name: "Audit pages" });

/** A School Administrator in the first School, on its Audit sheet. */
async function openAudit(page: Page): Promise<string> {
  const { schoolAdministrator, schools } = seeded();
  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[0]!);
  const schoolId = await schoolIdOf(page, schools[0]!);
  return schoolId;
}

test("a change made in the School is listed newest first, named by who made it and what it was made to", async ({
  page,
  audit,
}) => {
  const schoolId = await openAudit(page);
  const displayName = `Morgan ${randomUUID().slice(0, 8)}`;
  const personId = await arrangePerson(page, schoolId, displayName, []);

  await openSection(page, "Audit");

  // Other specs write to this School's trail as this one runs, so the record is
  // looked for by what it names rather than by where it falls.
  const created = rows(page).filter({ hasText: "person.created" }).filter({ hasText: displayName });
  await expect(created).toHaveCount(1);
  await expect(created).toContainText(seeded().schoolAdministrator.displayName);
  await expect(created.getByText(personId)).toBeVisible();
  await expect(created.getByRole("time")).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);
  await expect(pager(page).getByRole("status")).toContainText("Page 1: records 1 to");
  await audit(page);
});

test.describe("paged by the cursor each page carries", () => {
  const RECORD = {
    occurredAt: "2026-09-01T09:30:15.000Z",
    actorPersonId: null,
    actorPlatformAdministratorId: null,
    target: { type: "request", id: `GET /api/schools/${randomUUID()}/persons/${randomUUID()}` },
    reason: "no-such-person",
  };
  const PAGES: Record<string, { auditRecords: unknown[]; nextCursor: string | null }> = {
    first: {
      auditRecords: [
        { ...RECORD, id: randomUUID(), action: "newest.one" },
        { ...RECORD, id: randomUUID(), action: "newest.two" },
      ],
      nextCursor: "00000000-0000-4000-8000-000000000001",
    },
    "00000000-0000-4000-8000-000000000001": {
      auditRecords: [{ ...RECORD, id: randomUUID(), action: "oldest.one" }],
      nextCursor: null,
    },
  };

  /**
   * Answers the trail from `PAGES` by the cursor asked for, so the paging is
   * asserted against pages of a known length. The server's own bound and
   * ordering are the API suite's to assert.
   */
  async function stubTrail(page: Page): Promise<string[]> {
    const asked: string[] = [];
    await page.route("**/api/schools/*/audit-records*", (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      asked.push(cursor ?? "first");
      return route.fulfill({ status: 200, json: PAGES[cursor ?? "first"] });
    });
    return asked;
  }

  test("pages older and back to newer, saying which page is shown", async ({ page, audit }) => {
    await openAudit(page);
    const asked = await stubTrail(page);
    await openSection(page, "Audit");
    const newer = pager(page).getByRole("button", { name: "Newer" });
    const older = pager(page).getByRole("button", { name: "Older" });
    const status = pager(page).getByRole("status");

    await expect(status).toHaveText("Page 1: records 1 to 2, newest first.");
    await expect(rows(page).filter({ hasText: "newest." })).toHaveCount(2);
    await expect(newer).toHaveAttribute("aria-disabled", "true");
    await expect(older).toHaveAttribute("aria-disabled", "false");

    await older.click();
    await expect(status).toHaveText("Page 2: records 3 to 3, newest first. The last page.");
    await expect(rows(page).filter({ hasText: "oldest.one" })).toHaveCount(1);
    await expect(rows(page).filter({ hasText: "newest." })).toHaveCount(0);
    // At the end the control is held, and keeps the focus it was pressed with.
    await expect(older).toHaveAttribute("aria-disabled", "true");
    await expect(older).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(status).toHaveText("Page 2: records 3 to 3, newest first. The last page.");

    await newer.focus();
    await page.keyboard.press("Enter");
    await expect(status).toHaveText("Page 1: records 1 to 2, newest first.");
    await expect(rows(page).filter({ hasText: "newest." })).toHaveCount(2);

    // One page per request, each from the cursor the page before it carried.
    expect(asked).toEqual(["first", "00000000-0000-4000-8000-000000000001", "first"]);
    await audit(page);
  });

  test.describe("on a phone", () => {
    test.use({ viewport: { width: 360, height: 740 } });

    test("the record stacks, and a long request path wraps rather than scrolling", async ({ page, audit }) => {
      await openAudit(page);
      await stubTrail(page);
      await openSection(page, "Audit");
      await expect(rows(page).filter({ hasText: "newest.one" })).toHaveCount(1);

      await expectNoSidewaysScroll(page);
      await audit(page);
    });
  });
});
