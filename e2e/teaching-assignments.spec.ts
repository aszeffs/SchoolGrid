import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { arrange, arrangePerson, changesSent, openSection, recordRows, schoolIdOf, signIn, withOwnOffering } from "./app.ts";
import { seeded, type Account } from "./seeded.ts";
import { expect, expectNoSidewaysScroll, test } from "./test.ts";

/**
 * Teaching assignments: a School Administrator assigning Faculty to a Class
 * Offering on its page, the Roles sheet naming the assignments that ending a
 * Faculty membership ends, and a Faculty member's own classes. Which bounds
 * and Persons are refused, and what the cascade writes, is the HTTP suite's to
 * assert; this is about the pages doing it and saying what they do.
 *
 * Everything is arranged in the first seeded School, in a year far enough
 * ahead that no other spec's can overlap it. Every assignment there is still
 * to begin, so ending one removes it.
 */

/** The Person a seeded account resolves to in the first School, as its School Administrator lists it. */
async function personIdOf(page: Page, schoolId: string, account: Account): Promise<string> {
  const response = await page.request.get(`/api/schools/${schoolId}/persons`);
  const { persons } = (await response.json()) as { persons: { id: string; displayName: string }[] };
  return persons.find((person) => person.displayName === account.displayName)!.id;
}

const assignments = (page: Page) => recordRows(page, "Teaching assignments");

test("a School Administrator assigns Faculty to a Class Offering, changes the dates, and removes one", async ({
  page,
  audit,
}) => {
  const own = await withOwnOffering(page);
  const teacher = `Taylor ${randomUUID().slice(0, 8)}`;
  const coTeacher = `Casey ${randomUUID().slice(0, 8)}`;
  await arrangePerson(page, own.schoolId, teacher, ["faculty"]);
  await arrangePerson(page, own.schoolId, coTeacher, ["faculty"]);
  await page.goto(`/schools/${own.schoolId}/class-offerings/${own.classOfferingId}`);
  await expect(page.getByRole("heading", { level: 1, name: own.offering })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("No Faculty member is assigned to teach this offering yet.");

  // Left without dates, the first runs with the Term; the second starts later in it.
  const assign = page.getByRole("form", { name: "Assign Faculty to this Class Offering" });
  await assign.getByLabel("Faculty member").selectOption({ label: teacher });
  await assign.getByRole("button", { name: "Assign" }).click();
  await expect(page.getByRole("status").filter({ hasText: "is assigned" })).toHaveText(
    `${teacher} is assigned to teach ${own.offering}.`,
  );
  await assign.getByLabel("Faculty member").selectOption({ label: coTeacher });
  await assign.getByLabel("From (optional)").fill(own.term.lastDate.replace("06-30", "02-01"));
  await assign.getByRole("button", { name: "Assign" }).click();
  await expect(assignments(page)).toHaveCount(3);
  await expect(assignments(page).filter({ hasText: teacher })).toContainText("End of Term");
  await audit(page);

  // Assigning the same Person again for days they already teach it is refused, saying why.
  await assign.getByLabel("Faculty member").selectOption({ label: teacher });
  await assign.getByRole("button", { name: "Assign" }).click();
  await expect(assign.getByRole("alert")).toHaveText(
    "That Faculty member is already assigned to this offering for some of those days. Their assignments to it cannot overlap.",
  );

  // Its dates changed in a dialog.
  await page.getByRole("button", { name: `Change the dates of ${teacher}’s Teaching assignment` }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Until (optional)").fill(own.term.lastDate.replace("06-30", "01-31"));
  await audit(page);
  await dialog.getByRole("button", { name: "Save the dates" }).click();
  await expect(page.getByRole("status").filter({ hasText: "are changed" })).toHaveText(
    `The dates of ${teacher}’s Teaching assignment are changed.`,
  );
  await expect(assignments(page).filter({ hasText: teacher })).not.toContainText("End of Term");

  // Not yet begun, so ending it removes it.
  await page.getByRole("button", { name: `End ${coTeacher}’s Teaching assignment` }).click();
  await expect(dialog).toContainText("It has not begun, so it is removed");
  await dialog.getByRole("button", { name: "Remove the assignment" }).click();
  await expect(assignments(page)).toHaveCount(2);
  await expect(assignments(page).filter({ hasText: coTeacher })).toHaveCount(0);

  // What the page shows is what the server holds, and it opens from its URL.
  await page.reload();
  await expect(assignments(page).filter({ hasText: teacher })).toHaveCount(1);

  // An offering someone was assigned to is not deleted, saying why.
  await page.getByRole("button", { name: "Delete Class Offering" }).click();
  await dialog.getByRole("button", { name: "Delete the Class Offering" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Faculty have been assigned to this offering, and it is not deleted once they have: the assignments are the record of who taught it.",
  );
});

test("ending a Faculty membership names the Teaching assignments it ends, and cancelling sends nothing", async ({
  page,
  audit,
}) => {
  const own = await withOwnOffering(page);
  const teacher = `Morgan ${randomUUID().slice(0, 8)}`;
  const personId = await arrangePerson(page, own.schoolId, teacher, ["faculty"]);
  await arrange(page, own.schoolId, `/class-offerings/${own.classOfferingId}/teaching-assignments`, { personId });
  await openSection(page, "Roles");
  const row = recordRows(page, "School memberships in force").filter({ hasText: teacher });
  await expect(row).toContainText("No end");
  const sent = changesSent(page);

  await page.getByRole("button", { name: `Revoke ${teacher}’s Faculty membership` }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("1 Teaching assignment.");
  await expect(dialog).toContainText(`Those of ${teacher}’s still running after today end today`);
  await audit(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  // Narrowed to a day after the assignment's Term, it ends none.
  await page.getByRole("button", { name: `Narrow ${teacher}’s Faculty membership` }).click();
  await dialog.getByLabel("Ends on").fill(own.term.lastDate.replace("06-30", "12-31"));
  await expect(dialog).toContainText("0 Teaching assignments.");
  await dialog.getByLabel("Ends on").fill(own.term.lastDate.replace("06-30", "01-31"));
  await expect(dialog).toContainText("1 Teaching assignment.");
  await audit(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  expect(sent).toEqual([]);
  await page.reload();
  await expect(row).toContainText("No end");
});

test.describe("with the browser fourteen hours ahead of UTC", () => {
  // Kiritimati's midnight is New York's 05:00 or 06:00 the day before, so a
  // day read in the browser's timezone would end the membership, and the
  // assignments with it, on the School date before the one picked.
  test.use({ timezoneId: "Pacific/Kiritimati" });

  test("narrowing a Faculty membership ends its Teaching assignments on the School date picked", async ({ page }) => {
    const own = await withOwnOffering(page);
    const teacher = `Jordan ${randomUUID().slice(0, 8)}`;
    const personId = await arrangePerson(page, own.schoolId, teacher, ["faculty"]);
    await arrange(page, own.schoolId, `/class-offerings/${own.classOfferingId}/teaching-assignments`, { personId });
    await openSection(page, "Roles");
    const row = recordRows(page, "School memberships in force").filter({ hasText: teacher });
    const endsOn = own.term.lastDate.replace("06-30", "01-31");

    await page.getByRole("button", { name: `Narrow ${teacher}’s Faculty membership` }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Ends on").fill(endsOn);
    await expect(dialog).toContainText("1 Teaching assignment.");
    await dialog.getByRole("button", { name: "Set the end" }).click();
    await expect(row).not.toContainText("No end");

    // Midnight in New York, on Eastern Standard Time in January.
    const memberships = await page.request.get(`/api/schools/${own.schoolId}/memberships`);
    const { memberships: held } = (await memberships.json()) as {
      memberships: { personId: string; role: string; endsAt: string | null }[];
    };
    expect(held.find((membership) => membership.personId === personId && membership.role === "faculty")?.endsAt).toBe(
      `${endsOn}T05:00:00.000Z`,
    );
    const offering = await page.request.get(`/api/schools/${own.schoolId}/class-offerings/${own.classOfferingId}`);
    const { classOffering } = (await offering.json()) as {
      classOffering: { teachingAssignments: { person: { id: string }; lastDate: string | null }[] };
    };
    expect(classOffering.teachingAssignments).toEqual([
      expect.objectContaining({ person: expect.objectContaining({ id: personId }), lastDate: endsOn }),
    ]);
  });
});

test("a Faculty member finds their classes in the navigation and reads who teaches each", async ({ page, audit }) => {
  const { faculty, schools } = seeded();
  const own = await withOwnOffering(page);
  const coTeacher = `Robin ${randomUUID().slice(0, 8)}`;
  const coTeacherId = await arrangePerson(page, own.schoolId, coTeacher, ["faculty"]);
  const path = `/class-offerings/${own.classOfferingId}/teaching-assignments`;
  await arrange(page, own.schoolId, path, { personId: await personIdOf(page, own.schoolId, faculty) });
  await arrange(page, own.schoolId, path, { personId: coTeacherId });
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/sign-in");

  await signIn(page, faculty);
  await openSection(page, "Your classes");
  await expect(page.getByRole("heading", { level: 1, name: "Your classes" })).toBeVisible();
  const current = recordRows(page, "Your current Class Offerings").filter({ hasText: own.offering });
  await expect(current).toContainText(coTeacher);
  await audit(page);

  await current.getByRole("link", { name: own.offering }).click();
  await expect(page.getByRole("heading", { level: 1, name: own.offering })).toBeVisible();
  await expect(assignments(page).filter({ hasText: faculty.displayName })).toHaveCount(1);
  await expect(assignments(page).filter({ hasText: coTeacher })).toHaveCount(1);
  // Read, and nothing offered to change.
  await expect(page.getByRole("form")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(End|Change the dates of) / })).toHaveCount(0);
  await audit(page);

  // It opens from its URL, and another School's page, or one never taught, is the one refusal.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: own.offering })).toBeVisible();
  await page.goto(`/schools/${await schoolIdOf(page, schools[0]!)}/class-offerings/${randomUUID()}`);
  await expect(page.getByRole("heading", { level: 1, name: "Not available" })).toBeVisible();
});

test("a Faculty member with no class is told so, and other roles are not offered the page", async ({ page, audit }) => {
  const { severalRoles, guardian, schools } = seeded();
  await signIn(page, severalRoles);
  await openSection(page, "Your classes");
  await expect(page.getByRole("main")).toContainText("You teach no Class Offering yet.");
  await audit(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/sign-in");

  await signIn(page, guardian);
  await expect(page.getByRole("navigation")).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("link", { name: "Your classes" })).toHaveCount(0);
  await page.goto(`/schools/${await schoolIdOf(page, schools[0]!)}/classes`);
  await expect(page.getByRole("heading", { level: 1, name: "Not available" })).toBeVisible();
});

test("a Person who is both Faculty and a Student finds the Class Offerings they teach and those they are on the roster of", async ({
  page,
  audit,
}) => {
  const own = await withOwnOffering(page);
  const token = randomUUID().slice(0, 8);
  const personId = await arrangePerson(page, own.schoolId, `Casey ${token}`, ["faculty", "student"]);
  await arrange(page, own.schoolId, "/enrollments", { studentPersonId: personId });
  await arrange(page, own.schoolId, `/class-offerings/${own.classOfferingId}/teaching-assignments`, { personId });
  const { classOffering: taken } = await arrange<{ classOffering: { id: string } }>(
    page,
    own.schoolId,
    "/class-offerings",
    { courseId: own.courseId, termId: own.term.id, label: "Section B" },
  );
  await arrange(page, own.schoolId, `/class-offerings/${taken.id}/roster-memberships`, { personIds: [personId] });
  // Redeeming an Invitation to them signs the page in as their new account.
  const { link } = await arrange<{ link: string }>(page, own.schoolId, "/invitations", { personId });
  const redeemed = await page.request.post("/api/invitations/redeem", {
    headers: { origin: new URL(page.url()).origin },
    data: { secret: new URL(link).hash.slice(1), username: `casey-${token}`, password: "a teacher who studies too" },
  });
  expect(redeemed.status()).toBe(201);

  await page.goto(`/schools/${own.schoolId}/account`);
  await openSection(page, "Your classes");
  await expect(page.getByRole("heading", { level: 2, name: "Class Offerings you teach" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Class Offerings you are on the roster of" })).toBeVisible();
  await expect(recordRows(page, "Your current Class Offerings").filter({ hasText: own.offering })).toHaveCount(1);
  await expect(
    page
      .getByRole("table", { name: /^Your Class Offerings in / })
      .getByRole("row")
      .filter({ hasText: own.offering.replace(/Section A$/, "Section B") }),
  ).toHaveCount(1);
  await audit(page);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the Class Offering, the Roles confirmation and Your classes hold 360px in the ${colorScheme} rendition`, async ({ page, audit }) => {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      const { faculty } = seeded();
      const own = await withOwnOffering(page);
      await arrange(page, own.schoolId, `/class-offerings/${own.classOfferingId}/teaching-assignments`, {
        personId: await personIdOf(page, own.schoolId, faculty),
      });

      await page.goto(`/schools/${own.schoolId}/class-offerings/${own.classOfferingId}`);
      await expect(assignments(page)).toHaveCount(1);
      await expectNoSidewaysScroll(page);
      await audit(page);

      // The Roles confirmation naming the assignments that ending the membership ends.
      await openSection(page, "Roles");
      await page.getByRole("button", { name: `Revoke ${faculty.displayName}’s Faculty membership` }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText(/\d+ Teaching assignments?\./);
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeInViewport();
      await expectNoSidewaysScroll(page);
      await audit(page);
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(page).toHaveURL("/sign-in");

      await signIn(page, faculty);
      await expect(page.getByRole("heading", { level: 1, name: "Your account" })).toBeVisible();
      await page.goto(`/schools/${own.schoolId}/classes`);
      await expect(recordRows(page, "Your current Class Offerings").filter({ hasText: own.offering })).toHaveCount(1);
      await expectNoSidewaysScroll(page);
      await audit(page);
    });
  }
});
