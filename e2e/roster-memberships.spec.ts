import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import {
  arrange,
  arrangePerson,
  changesSent,
  openSchool,
  openSection,
  recordRows,
  schoolIdOf,
  schoolsList,
  signIn,
} from "./app.ts";
import { seeded } from "./seeded.ts";
import { expect, expectNoSidewaysScroll, test } from "./test.ts";

/**
 * Roster memberships: a School Administrator rostering several Students in one
 * go on a Class Offering's page, the Enrollments sheet counting the memberships
 * that ending an Enrollment ends, and a Student's own classes, before and after
 * they depart. Which Students and bounds are refused, and what the cascade
 * writes, is the HTTP suite's to assert; this is about the pages doing it and
 * saying what they do.
 *
 * Everything is arranged in the first seeded School, in a year far enough
 * ahead that no other spec's can overlap it. Every membership there is still
 * to begin, so ending one removes it.
 */

interface Own {
  schoolId: string;
  classOfferingId: string;
  /** The offering as its page is headed: its Course and label. */
  offering: string;
  /** The Term it runs in, as `YYYY-MM-DD`, and its name as a Student's page heads it. */
  term: { firstDate: string; lastDate: string; heading: string };
}

/** A School Administrator in the first School, with a Class Offering of the test's own in a year of its own. */
async function withOwnOffering(page: Page): Promise<Own> {
  const { schoolAdministrator, schools } = seeded();
  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[0]!);
  const schoolId = await schoolIdOf(page, schools[0]!);
  const starts = 2100 + Math.floor(Math.random() * 7000);
  const term = { firstDate: `${starts}-09-01`, lastDate: `${starts + 1}-06-30` };
  const yearName = `Year ${randomUUID().slice(0, 8)}`;
  const { academicYear } = await arrange<{ academicYear: { id: string } }>(page, schoolId, "/academic-years", {
    name: yearName,
    ...term,
  });
  const divided = await page.request.patch(`/api/schools/${schoolId}/academic-years/${academicYear.id}`, {
    headers: { origin: new URL(page.url()).origin },
    data: { terms: [{ name: "Whole year", ...term }] },
  });
  expect(divided.ok()).toBe(true);
  const { academicYear: year } = (await divided.json()) as { academicYear: { terms: { id: string }[] } };
  const courseName = `Course ${randomUUID().slice(0, 8)}`;
  const { course } = await arrange<{ course: { id: string } }>(page, schoolId, "/courses", { name: courseName });
  const { classOffering } = await arrange<{ classOffering: { id: string } }>(page, schoolId, "/class-offerings", {
    courseId: course.id,
    termId: year.terms[0]!.id,
    label: "Section A",
  });
  return {
    schoolId,
    classOfferingId: classOffering.id,
    offering: `${courseName}, Section A`,
    term: { ...term, heading: `Whole year, ${yearName}` },
  };
}

/** A Student of the spec's own, holding an open Enrollment, and returns their Person. */
async function arrangeStudent(page: Page, schoolId: string, displayName: string): Promise<string> {
  const personId = await arrangePerson(page, schoolId, displayName, ["student"]);
  await arrange(page, schoolId, "/enrollments", { studentPersonId: personId });
  return personId;
}

/**
 * Gives a Person of the spec's own a User account, by redeeming an Invitation
 * to them, which signs the page in as that account. Returns what it signs in with.
 */
async function giveAccount(page: Page, schoolId: string, personId: string) {
  const { link } = await arrange<{ link: string }>(page, schoolId, "/invitations", { personId });
  const credentials = { username: `student-${randomUUID().slice(0, 8)}`, password: "a Student's own staple, long enough" };
  const redeemed = await page.request.post("/api/invitations/redeem", {
    headers: { origin: new URL(page.url()).origin },
    data: { secret: new URL(link).hash.slice(1), ...credentials },
  });
  expect(redeemed.status()).toBe(201);
  return credentials;
}

const roster = (page: Page) => recordRows(page, "Roster");

test("a School Administrator rosters several Students in one go from the keyboard, and removes one", async ({
  page,
  audit,
}) => {
  const own = await withOwnOffering(page);
  const token = randomUUID().slice(0, 8);
  const first = `Rowan ${token}`;
  const second = `Riley ${token}`;
  await arrangeStudent(page, own.schoolId, first);
  await arrangeStudent(page, own.schoolId, second);
  await page.goto(`/schools/${own.schoolId}/class-offerings/${own.classOfferingId}`);
  await expect(page.getByRole("heading", { level: 1, name: own.offering })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("No Student is on this roster yet.");

  await page.getByRole("button", { name: "Roster Students" }).click();
  const dialog = page.getByRole("dialog");
  // Found by name, and ticked with the keyboard alone.
  await dialog.getByLabel("Find by name").focus();
  await page.keyboard.type(token);
  await expect(dialog.getByRole("checkbox")).toHaveCount(2);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Space");
  await expect(dialog.getByRole("status")).toHaveText("2 Students chosen.");
  await audit(page);
  await dialog.getByRole("button", { name: "Roster 2 Students" }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "rostered" })).toHaveText(
    `2 Students are rostered in ${own.offering}.`,
  );
  await expect(roster(page)).toHaveCount(3);
  await expect(roster(page).filter({ hasText: first })).toContainText("End of Term");

  // Those on the roster are not offered again.
  await page.getByRole("button", { name: "Roster Students" }).click();
  await dialog.getByLabel("Find by name").fill(token);
  await expect(dialog).toContainText("No Student listed here has that in their name.");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // Not yet begun, so ending it removes it.
  await page.getByRole("button", { name: `End ${second}’s Roster membership` }).click();
  await expect(dialog).toContainText("It has not begun, so it is removed");
  await dialog.getByRole("button", { name: "Remove the membership" }).click();
  await expect(roster(page)).toHaveCount(2);

  // What the page shows is what the server holds, and it opens from its URL.
  await page.reload();
  await expect(roster(page).filter({ hasText: first })).toHaveCount(1);
  await expect(roster(page).filter({ hasText: second })).toHaveCount(0);

  // An offering someone was rostered in is not deleted, saying why.
  await page.getByRole("button", { name: "Delete Class Offering" }).click();
  await dialog.getByRole("button", { name: "Delete the Class Offering" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Students have been rostered in this offering, and it is not deleted once they have: the memberships are the record of who was in the class.",
  );
});

test("ending an Enrollment counts the Roster memberships it ends, and cancelling sends nothing", async ({
  page,
  audit,
}) => {
  const own = await withOwnOffering(page);
  const student = `Jordan ${randomUUID().slice(0, 8)}`;
  const personId = await arrangeStudent(page, own.schoolId, student);
  await arrange(page, own.schoolId, `/class-offerings/${own.classOfferingId}/roster-memberships`, {
    personIds: [personId],
  });
  await openSection(page, "Enrollments");
  const sent = changesSent(page);

  await page.getByRole("button", { name: `End ${student}’s Enrollment` }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("1 open Roster membership.");
  await expect(dialog).toContainText(`Those of ${student}’s still running end today`);
  await audit(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  expect(sent).toEqual([]);
  await page.reload();
  await expect(recordRows(page, "Open Enrollments").filter({ hasText: student })).toHaveCount(1);
});

test("a Student finds their classes by Term with who teaches each, and keeps them once departed", async ({
  page,
  audit,
}) => {
  const { schoolAdministrator } = seeded();
  const own = await withOwnOffering(page);
  const student = `Quinn ${randomUUID().slice(0, 8)}`;
  const personId = await arrangeStudent(page, own.schoolId, student);
  const teacher = `Taylor ${randomUUID().slice(0, 8)}`;
  const teacherId = await arrangePerson(page, own.schoolId, teacher, ["faculty"]);
  await arrange(page, own.schoolId, `/class-offerings/${own.classOfferingId}/teaching-assignments`, {
    personId: teacherId,
  });
  await arrange(page, own.schoolId, `/class-offerings/${own.classOfferingId}/roster-memberships`, {
    personIds: [personId],
  });
  const { enrollments } = (await (await page.request.get(`/api/schools/${own.schoolId}/enrollments`)).json()) as {
    enrollments: { id: string; studentPersonId: string }[];
  };
  const enrollmentId = enrollments.find((each) => each.studentPersonId === personId)!.id;
  const credentials = await giveAccount(page, own.schoolId, personId);

  const readClasses = async () => {
    await page.goto(`/schools/${own.schoolId}/account`);
    await openSection(page, "Your classes");
    await expect(page.getByRole("heading", { level: 1, name: "Your classes" })).toBeVisible();
    const row = recordRows(page, `Your classes in ${own.term.heading}`).filter({ hasText: own.offering });
    await expect(row).toContainText(teacher);
    await expect(row).toContainText("The whole Term");
    return row;
  };
  const row = await readClasses();
  await audit(page);

  // Its page names who teaches it, and never who else is in it.
  await row.getByRole("link", { name: own.offering }).click();
  await expect(page.getByRole("heading", { level: 1, name: own.offering })).toBeVisible();
  await expect(recordRows(page, "Teaching assignments").filter({ hasText: teacher })).toHaveCount(1);
  await expect(page.getByRole("table", { name: "Roster", exact: true })).toHaveCount(0);
  await expect(page.getByRole("form")).toHaveCount(0);
  await audit(page);

  // Departed, they keep the classes they took part in.
  await page.getByRole("button", { name: "Sign out" }).click();
  await signIn(page, schoolAdministrator);
  await expect(schoolsList(page)).not.toHaveCount(0);
  const ended = await page.request.delete(`/api/schools/${own.schoolId}/enrollments/${enrollmentId}`, {
    headers: { origin: new URL(page.url()).origin },
    data: { reason: "Moved away" },
  });
  expect(ended.ok()).toBe(true);
  await page.getByRole("button", { name: "Sign out" }).click();
  await signIn(page, credentials);
  await expect(page.getByRole("navigation")).toBeVisible();
  await (await readClasses()).getByRole("link", { name: own.offering }).click();
  await expect(page.getByRole("heading", { level: 1, name: own.offering })).toBeVisible();
});

test("a Student with no class is told so", async ({ page, audit }) => {
  const own = await withOwnOffering(page);
  const personId = await arrangeStudent(page, own.schoolId, `Avery ${randomUUID().slice(0, 8)}`);
  await giveAccount(page, own.schoolId, personId);

  await page.goto(`/schools/${own.schoolId}/classes`);
  await expect(page.getByRole("main")).toContainText("You have no classes yet.");
  await audit(page);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the roster, its dialog, the Enrollment confirmation and a Student's classes hold 360px in the ${colorScheme} rendition`, async ({
      page,
      audit,
    }) => {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      const own = await withOwnOffering(page);
      const student = `Emery ${randomUUID().slice(0, 8)}`;
      const personId = await arrangeStudent(page, own.schoolId, student);
      await arrangeStudent(page, own.schoolId, `Ellis ${randomUUID().slice(0, 8)}`);
      await arrange(page, own.schoolId, `/class-offerings/${own.classOfferingId}/roster-memberships`, {
        personIds: [personId],
      });

      await page.goto(`/schools/${own.schoolId}/class-offerings/${own.classOfferingId}`);
      await expect(roster(page)).toHaveCount(2);
      await expectNoSidewaysScroll(page);
      await audit(page);
      await page.getByRole("button", { name: "Roster Students" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeInViewport();
      await expectNoSidewaysScroll(page);
      await audit(page);
      await dialog.getByRole("button", { name: "Cancel" }).click();

      await openSection(page, "Enrollments");
      await page.getByRole("button", { name: `End ${student}’s Enrollment` }).click();
      await expect(dialog).toContainText("1 open Roster membership.");
      await expectNoSidewaysScroll(page);
      await audit(page);
      await dialog.getByRole("button", { name: "Cancel" }).click();

      await giveAccount(page, own.schoolId, personId);
      await page.goto(`/schools/${own.schoolId}/classes`);
      await expect(recordRows(page, `Your classes in ${own.term.heading}`)).toHaveCount(2);
      await expectNoSidewaysScroll(page);
      await audit(page);
    });
  }
});
