import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { arrange, arrangePerson, changesSent, openSchool, openSection, recordRows, schoolIdOf, signIn } from "./app.ts";
import { seeded } from "./seeded.ts";
import { expect, expectNoSidewaysScroll, test } from "./test.ts";

/**
 * Enrollments: where a Student's participation in the School is started and
 * ended. Ending one is the most consequential action in the app, so what is
 * asserted above all is that its confirmation names the whole cascade, with
 * the counts, and that cancelling it leaves the server untouched.
 */

const open = (page: Page) => recordRows(page, "Open Enrollments");
const ended = (page: Page) => recordRows(page, "Ended Enrollments");

interface Arranged {
  schoolId: string;
  student: { id: string; displayName: string };
}

/** A School Administrator in the first School, with a Student of this run's own not yet enrolled. */
async function withStudent(page: Page): Promise<Arranged> {
  const { schoolAdministrator, schools } = seeded();
  const displayName = `Jordan ${randomUUID().slice(0, 8)}`;
  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[0]!);
  const schoolId = await schoolIdOf(page, schools[0]!);
  const id = await arrangePerson(page, schoolId, displayName, ["student"]);
  return { schoolId, student: { id, displayName } };
}

async function startEnrollment(page: Page, displayName: string) {
  const form = page.getByRole("form", { name: "Start an Enrollment" });
  await form.getByLabel("Student").selectOption({ label: displayName });
  await form.getByRole("button", { name: "Start Enrollment" }).click();
}

test("an Enrollment is started, and ending it names the cascade before it goes ahead", async ({ page, audit }) => {
  const { schoolId, student } = await withStudent(page);
  await openSection(page, "Enrollments");
  await startEnrollment(page, student.displayName);
  await expect(open(page).filter({ hasText: student.displayName })).toContainText("Open");

  // Two Guardians of this Student, so the count the confirmation strikes is
  // one the sheet had to read rather than one it could assume.
  const guardians = [`Quinn ${randomUUID().slice(0, 8)}`, `Riley ${randomUUID().slice(0, 8)}`];
  for (const guardian of guardians) {
    const guardianPersonId = await arrangePerson(page, schoolId, guardian, ["guardian"]);
    await arrange(page, schoolId, "/guardian-links", {
      guardianPersonId,
      studentPersonId: student.id,
      accessProfile: { attendanceRead: true, resultsRead: false },
    });
  }
  await page.reload();

  await page.getByRole("button", { name: `End ${student.displayName}’s Enrollment` }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("0 open Roster memberships");
  await expect(dialog).toContainText("2 Guardian links");
  for (const guardian of guardians) {
    await expect(dialog).toContainText(guardian);
  }
  await expect(dialog).toContainText("access narrows to their published records");
  await expect(dialog).toContainText("Every record stays in place");
  // An Enrollment does not end without a reason.
  await expect(dialog.getByRole("button", { name: "End the Enrollment" })).toBeDisabled();
  await audit(page);

  await dialog.getByLabel("Reason").fill("Moved out of the district");
  await dialog.getByRole("button", { name: "End the Enrollment" }).click();
  await expect(open(page).filter({ hasText: student.displayName })).toHaveCount(0);
  await expect(ended(page).filter({ hasText: student.displayName })).toContainText("Moved out of the district");

  // Both links ended with it, and are on the Guardians sheet as ended.
  await openSection(page, "Guardians");
  for (const guardian of guardians) {
    await expect(recordRows(page, "Ended Guardian links").filter({ hasText: guardian })).toHaveCount(1);
    await expect(recordRows(page, "Guardian links in force").filter({ hasText: guardian })).toHaveCount(0);
  }
});

test("a cancelled ending sends nothing and leaves the Enrollment open", async ({ page }) => {
  const { schoolId, student } = await withStudent(page);
  await arrange(page, schoolId, "/enrollments", { studentPersonId: student.id });
  await openSection(page, "Enrollments");
  await expect(open(page).filter({ hasText: student.displayName })).toHaveCount(1);
  const sent = changesSent(page);

  const end = page.getByRole("button", { name: `End ${student.displayName}’s Enrollment` });
  await end.click();
  // Named as the Student has none, and said so rather than left out.
  await expect(page.getByRole("dialog")).toContainText("0 Guardian links");
  await page.getByRole("dialog").getByLabel("Reason").fill("Changed my mind");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await end.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  expect(sent).toEqual([]);
  await page.reload();
  await expect(open(page).filter({ hasText: student.displayName })).toHaveCount(1);
  await expect(ended(page).filter({ hasText: student.displayName })).toHaveCount(0);
});

test("with no Enrollment to list, the sheet says so and offers the first", async ({ page, audit }) => {
  const { student } = await withStudent(page);
  await page.route("**/api/schools/*/enrollments", (route) =>
    route.request().method() === "GET" ? route.fulfill({ status: 200, json: { enrollments: [] } }) : route.fallback(),
  );
  await openSection(page, "Enrollments");

  await expect(page.getByRole("main")).toContainText("No Student is enrolled in this School.");
  await expect(page.getByRole("main")).toContainText("No Enrollment in this School has ended.");
  // The first action is offered: a Person holding a Student membership is waiting.
  const form = page.getByRole("form", { name: "Start an Enrollment" });
  await expect(form.getByRole("option", { name: student.displayName })).toHaveCount(1);
  await audit(page);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("the record stacks, and the ending's confirmation is readable", async ({ page, audit }) => {
    const { schoolId, student } = await withStudent(page);
    await arrange(page, schoolId, "/enrollments", { studentPersonId: student.id });
    await openSection(page, "Enrollments");
    await expect(open(page).filter({ hasText: student.displayName })).toHaveCount(1);
    await expectNoSidewaysScroll(page);
    await audit(page);

    await page.getByRole("button", { name: `End ${student.displayName}’s Enrollment` }).click();
    await expect(page.getByRole("dialog").getByLabel("Reason")).toBeVisible();
    await expectNoSidewaysScroll(page);
    await audit(page);
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  });
});
