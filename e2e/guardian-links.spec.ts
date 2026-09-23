import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { arrange, arrangePerson, changesSent, openSchool, openSection, recordRows, schoolIdOf, signIn } from "./app.ts";
import { seeded } from "./seeded.ts";
import { expect, expectNoSidewaysScroll, test } from "./test.ts";

/**
 * Guardians: the Guardian links sheet, where a School Administrator links a
 * Guardian to an enrolled Student, sets that link's Access profile, and ends
 * the link. The profile's two permissions are set independently, and the sheet
 * says plainly that neither takes effect until academic records ship.
 */

const inForce = (page: Page) => recordRows(page, "Guardian links in force");
const ended = (page: Page) => recordRows(page, "Ended Guardian links");

interface Arranged {
  schoolId: string;
  guardian: { id: string; displayName: string };
  student: { id: string; displayName: string };
}

/** A School Administrator in the first School, with a Guardian and an enrolled Student of this run's own. */
async function withFamily(page: Page): Promise<Arranged> {
  const { schoolAdministrator, schools } = seeded();
  const suffix = randomUUID().slice(0, 8);
  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[0]!);
  const schoolId = await schoolIdOf(page, schools[0]!);
  const guardian = { displayName: `Parker ${suffix}`, id: "" };
  const student = { displayName: `Emerson ${suffix}`, id: "" };
  guardian.id = await arrangePerson(page, schoolId, guardian.displayName, ["guardian"]);
  student.id = await arrangePerson(page, schoolId, student.displayName, ["student"]);
  await arrange(page, schoolId, "/enrollments", { studentPersonId: student.id });
  return { schoolId, guardian, student };
}

/** One of a link's two permissions, as the control on its row names it. */
function permission(page: Page, name: "Attendance read" | "Results read", { guardian, student }: Arranged) {
  return page.getByRole("checkbox", { name: `${name} on ${guardian.displayName}’s link to ${student.displayName}` });
}

test("a Guardian is linked, and each permission of the Access profile is set on its own", async ({ page, audit }) => {
  const arranged = await withFamily(page);
  const { guardian, student } = arranged;
  await openSection(page, "Guardians");
  await expect(page.getByRole("main")).toContainText("take effect once academic records ship");

  const form = page.getByRole("form", { name: "Make a Guardian link" });
  await form.getByLabel("Guardian").selectOption({ label: guardian.displayName });
  await form.getByLabel("Student").selectOption({ label: student.displayName });
  await form.getByLabel("Attendance read").check();
  await form.getByRole("button", { name: "Link Guardian" }).click();

  const attendance = permission(page, "Attendance read", arranged);
  const results = permission(page, "Results read", arranged);
  await expect(attendance).toBeChecked();
  await expect(results).not.toBeChecked();
  await expect(inForce(page).filter({ hasText: guardian.displayName })).toContainText("May not read");
  await audit(page);

  // Each change names the one permission it sets, and leaves the other as it
  // stands. Clicked rather than checked: the box is not ticked until the server
  // has confirmed the change and the record has been read again.
  const patched = page.waitForRequest((request) => request.method() === "PATCH");
  await results.click();
  expect((await patched).postDataJSON()).toEqual({ accessProfile: { resultsRead: true } });
  await expect(results).toBeChecked();
  await expect(attendance).toBeChecked();

  await attendance.click();
  await expect(attendance).not.toBeChecked();
  await expect(results).toBeChecked();

  // What the sheet shows is what the server holds.
  await page.reload();
  await expect(attendance).not.toBeChecked();
  await expect(results).toBeChecked();
});

test("ending a link is confirmed, and a cancelled ending sends nothing", async ({ page }) => {
  const arranged = await withFamily(page);
  const { schoolId, guardian, student } = arranged;
  await arrange(page, schoolId, "/guardian-links", {
    guardianPersonId: guardian.id,
    studentPersonId: student.id,
    accessProfile: { attendanceRead: true, resultsRead: true },
  });
  await openSection(page, "Guardians");
  await expect(inForce(page).filter({ hasText: guardian.displayName })).toHaveCount(1);
  const sent = changesSent(page);

  const end = page.getByRole("button", { name: `End ${guardian.displayName}’s link to ${student.displayName}` });
  await end.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(`${guardian.displayName} stops reaching ${student.displayName}`);
  await expect(dialog).toContainText("Enrollment");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(sent).toEqual([]);
  await page.reload();
  await expect(inForce(page).filter({ hasText: guardian.displayName })).toHaveCount(1);

  await end.click();
  await page.getByRole("dialog").getByRole("button", { name: "End the link" }).click();
  await expect(inForce(page).filter({ hasText: guardian.displayName })).toHaveCount(0);
  await expect(ended(page).filter({ hasText: guardian.displayName })).toHaveCount(1);
  // Ending the link left the Student's Enrollment alone.
  await openSection(page, "Enrollments");
  await expect(recordRows(page, "Open Enrollments").filter({ hasText: student.displayName })).toHaveCount(1);
});

test("with no link to list, the sheet says so and offers the first", async ({ page, audit }) => {
  const { guardian } = await withFamily(page);
  await page.route("**/api/schools/*/guardian-links", (route) =>
    route.request().method() === "GET" ? route.fulfill({ status: 200, json: { guardianLinks: [] } }) : route.fallback(),
  );
  await openSection(page, "Guardians");

  await expect(page.getByRole("main")).toContainText("No Guardian is linked to a Student in this School.");
  await expect(page.getByRole("main")).toContainText("No Guardian link in this School has ended.");
  const form = page.getByRole("form", { name: "Make a Guardian link" });
  await expect(form.getByRole("option", { name: guardian.displayName })).toHaveCount(1);
  await audit(page);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("the record stacks, and the permissions stay within reach", async ({ page, audit }) => {
    const arranged = await withFamily(page);
    await arrange(page, arranged.schoolId, "/guardian-links", {
      guardianPersonId: arranged.guardian.id,
      studentPersonId: arranged.student.id,
      accessProfile: { attendanceRead: false, resultsRead: true },
    });
    await openSection(page, "Guardians");
    const attendance = permission(page, "Attendance read", arranged);
    await attendance.scrollIntoViewIfNeeded();
    await expect(attendance).toBeInViewport();
    await expectNoSidewaysScroll(page);
    await audit(page);
  });
});
