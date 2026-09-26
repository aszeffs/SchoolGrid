import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { arrange, arrangePerson, cancelDialog, darken, personIdOf, signIn, withOwnOffering, type OwnOffering } from "./app.ts";
import { seeded } from "./seeded.ts";
import { expect, test } from "./test.ts";

/**
 * The academic structure screens, held to the same bar in the dark rendition
 * as the rest of the suite holds them to in the light one (ADR-0010), with
 * every Dialog a Class Offering's page opens, and the wall chart of a Term's
 * Class Offerings leading to each one's page.
 */

/** The spec's own offering, taught by the seeded Faculty member with the seeded Student on its roster. */
async function withTaughtOffering(page: Page): Promise<OwnOffering> {
  const { faculty, student } = seeded();
  const own = await withOwnOffering(page);
  const offering = `/class-offerings/${own.classOfferingId}`;
  await arrange(page, own.schoolId, `${offering}/teaching-assignments`, {
    personId: await personIdOf(page, own.schoolId, faculty),
  });
  await arrange(page, own.schoolId, `${offering}/roster-memberships`, {
    personIds: [await personIdOf(page, own.schoolId, student)],
  });
  return own;
}

async function auditDialog(page: Page, button: string, audit: (page: Page) => Promise<void>) {
  await page.getByRole("button", { name: button }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await audit(page);
  await cancelDialog(page);
}

test("a School Administrator's academic screens and their Dialogs stay legible in the dark rendition", async ({
  page,
  audit,
}) => {
  const { faculty, student } = seeded();
  const own = await withTaughtOffering(page);
  const yearName = own.term.option.slice(`${own.term.name}, `.length);
  // A Student not yet on the roster, so there is someone to roster.
  const joining = await arrangePerson(page, own.schoolId, `Jordan ${randomUUID().slice(0, 8)}`, ["student"]);
  await arrange(page, own.schoolId, "/enrollments", { studentPersonId: joining });
  await darken(page);

  await page.goto(`/schools/${own.schoolId}/academic-years`);
  await expect(page.getByRole("heading", { level: 2, name: yearName })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Instructional days" }).first()).toBeVisible();
  await audit(page);
  await page.getByRole("button", { name: `Change ${yearName}` }).click();
  await expect(page.getByRole("form", { name: `Change ${yearName}` })).toBeVisible();
  await audit(page);

  await page.goto(`/schools/${own.schoolId}/courses`);
  await expect(page.getByRole("heading", { level: 1, name: "Courses" })).toBeVisible();
  await audit(page);

  // The Term's wall chart names each offering's Course, Faculty and roster, and opens its page.
  await page.goto(`/schools/${own.schoolId}/class-offerings`);
  await page.getByLabel("Term").selectOption({ label: own.term.option });
  const block = page.getByRole("list", { name: `Wall chart of ${own.term.name}` }).getByRole("link");
  await expect(block).toHaveCount(1);
  await expect(block).toContainText(own.offering);
  await expect(block).toContainText(faculty.displayName);
  await expect(block).toContainText("1 Student");
  await audit(page);
  await block.click();
  await expect(page.getByRole("heading", { level: 1, name: own.offering })).toBeVisible();
  await audit(page);

  await auditDialog(page, `Change the dates of ${faculty.displayName}’s Teaching assignment`, audit);
  await auditDialog(page, `End ${faculty.displayName}’s Teaching assignment`, audit);
  await auditDialog(page, `Change the dates of ${student.displayName}’s Roster membership`, audit);
  await auditDialog(page, `End ${student.displayName}’s Roster membership`, audit);
  await auditDialog(page, "Roster Students", audit);
  await auditDialog(page, "Delete Class Offering", audit);
});

test("Your classes stays legible in the dark rendition, for the Faculty who teach and the Students on the roster", async ({
  page,
  audit,
}) => {
  const { faculty, student } = seeded();
  const own = await withTaughtOffering(page);
  await darken(page);

  for (const account of [faculty, student]) {
    await page.getByRole("button", { name: "Sign out" }).click();
    await signIn(page, account);
    await expect(page).not.toHaveURL(/sign-in/);
    await page.goto(`/schools/${own.schoolId}/classes`);
    await expect(page.getByRole("link", { name: own.offering })).toBeVisible();
    await audit(page);
  }
});
