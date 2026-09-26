import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { arrange, changesSent, openSchool, openSection, recordRows, schoolIdOf, signIn, withOwnTerm } from "./app.ts";
import { seeded } from "./seeded.ts";
import { expect, expectNoSidewaysScroll, test } from "./test.ts";

/**
 * Courses and Class Offerings: where a School Administrator keeps the
 * catalogue and offers it Term by Term. Which names and labels are refused is
 * the HTTP suite's to assert; this is about the pages doing it, saying why,
 * and each offering opening on a page of its own.
 *
 * Everything is arranged in the first seeded School under names of the test's
 * own, in a year far enough ahead that no other spec's can overlap it. The
 * second seeded School is left with no Course and no Term, for the empty
 * states.
 */

/** A Course of the test's own, arranged through the API. */
async function arrangeCourse(page: Page, schoolId: string, code: string | null = null) {
  const name = `Course ${randomUUID().slice(0, 8)}`;
  const { course } = await arrange<{ course: { id: string } }>(page, schoolId, "/courses", { name, code });
  return { id: course.id, name };
}

test("a Course is created, offered in a Term, and its Class Offering opens on its own page", async ({
  page,
  audit,
}) => {
  const { schoolId, term } = await withOwnTerm(page);
  const name = `Algebra ${randomUUID().slice(0, 8)}`;
  const code = `M-${randomUUID().slice(0, 6)}`;

  await openSection(page, "Courses");
  const define = page.getByRole("form", { name: "Define a Course" });
  await define.getByLabel("Name").fill(name);
  await define.getByLabel("Code").fill(code);
  await define.getByRole("button", { name: "Create Course" }).click();
  await expect(page.getByRole("status")).toHaveText(`${name} is created. Offer it in a Term on Class Offerings.`);
  await page.getByRole("searchbox", { name: "Find by name or code" }).fill(name);
  await expect(recordRows(page, "Courses")).toHaveCount(2);
  await audit(page);

  await openSection(page, "Class Offerings");
  await page.getByLabel("Term").selectOption({ label: term.option });
  const offer = page.getByRole("form", { name: `Offer a Course in ${term.name}` });
  await offer.getByLabel("Course").selectOption({ label: `${name} (${code})` });
  await offer.getByLabel("Label").fill("Section A");
  await offer.getByRole("button", { name: "Offer Course" }).click();
  await expect(page.getByRole("status")).toHaveText(`${name} is offered in ${term.name}.`);
  await audit(page);

  // A second offering of it in the Term needs a label of its own.
  await offer.getByLabel("Course").selectOption({ label: `${name} (${code})` });
  await offer.getByLabel("Label").fill("section a");
  await offer.getByRole("button", { name: "Offer Course" }).click();
  await expect(offer.getByRole("alert")).toHaveText(
    `${name} is already offered in ${term.name} with that label, or without one. Give this offering a label that tells the two apart.`,
  );

  // Listed with no one teaching it and no one on its roster, and saying so.
  const listed = recordRows(page, `Class Offerings in ${term.name}`).filter({ hasText: `${name}, Section A` });
  await expect(listed).toContainText("No one assigned");
  await expect(listed).toContainText("No Students");

  await recordRows(page, `Class Offerings in ${term.name}`).getByRole("link", { name: `${name}, Section A` }).click();
  await expect(page.getByRole("heading", { level: 1, name: `${name}, Section A` })).toBeVisible();
  await expect(page.getByRole("main")).toContainText(term.option);
  // The list it was opened from stays marked in the navigation.
  await expect(page.getByRole("navigation").getByRole("link", { name: "Class Offerings" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await audit(page);

  // And it opens from its URL, as a bookmark would.
  const url = page.url();
  await page.goto(url);
  await expect(page.getByRole("heading", { level: 1, name: `${name}, Section A` })).toBeVisible();
  expect(url).toMatch(new RegExp(`/schools/${schoolId}/class-offerings/[0-9a-f-]+$`));

  // Relabelled, then deleted once confirmed, back to the Term's list.
  await page.getByRole("form", { name: "Relabel this Class Offering" }).getByLabel("Label").fill("Period 1");
  await page.getByRole("button", { name: "Save label" }).click();
  await expect(page.getByRole("heading", { level: 1, name: `${name}, Period 1` })).toBeVisible();
  await page.getByRole("button", { name: "Delete Class Offering" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete the Class Offering" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Class Offerings" })).toBeVisible();
});

test("a Course that is offered is not deleted, and a cancelled deletion sends nothing", async ({ page, audit }) => {
  const { schoolId, term } = await withOwnTerm(page);
  const course = await arrangeCourse(page, schoolId);
  await arrange(page, schoolId, "/class-offerings", { courseId: course.id, termId: term.id });
  await openSection(page, "Courses");
  await page.getByRole("searchbox", { name: "Find by name or code" }).fill(course.name);
  const sent = changesSent(page);

  await page.getByRole("button", { name: `Delete ${course.name}` }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(`${course.name} is offered in 1 Class Offering.`);
  await audit(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: `Delete ${course.name}` })).toBeFocused();
  expect(sent).toEqual([]);

  await page.getByRole("button", { name: `Delete ${course.name}` }).click();
  await dialog.getByRole("button", { name: "Delete the Course" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "This Course is offered in a Term, and a Course is not deleted while it is offered. Delete its Class Offerings first.",
  );
  await expect(recordRows(page, "Courses")).toHaveCount(2);
});

test("a Course is renamed in place, and one sharing another's name is refused, saying why", async ({ page }) => {
  const { schoolId } = await withOwnTerm(page);
  const course = await arrangeCourse(page, schoolId);
  const other = await arrangeCourse(page, schoolId);
  await openSection(page, "Courses");

  await page.getByRole("button", { name: `Change ${course.name}` }).click();
  const editor = page.getByRole("form", { name: `Change ${course.name}` });
  await expect(editor.getByLabel("Name")).toBeFocused();
  await editor.getByLabel("Name").fill(other.name.toUpperCase());
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(editor.getByRole("alert")).toHaveText(
    "Another Course already has that name, however it is capitalised. Give this one a name that tells them apart.",
  );

  await editor.getByLabel("Name").fill(`${course.name} renamed`);
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toHaveText(`${course.name} renamed is saved.`);
  await expect(page.getByRole("button", { name: `Change ${course.name} renamed` })).toBeFocused();
});

test("a School with no Course and no Term says so on both pages, and says where to start", async ({ page, audit }) => {
  const { schoolAdministrator, schools } = seeded();
  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[1]!);

  await openSection(page, "Courses");
  await expect(page.getByRole("main")).toContainText("This School has no Course yet.");
  await expect(page.getByRole("form", { name: "Define a Course" })).toBeVisible();
  await audit(page);

  await openSection(page, "Class Offerings");
  await expect(page.getByRole("main")).toContainText("This School has no Terms yet, and every Class Offering runs in one.");
  await expect(page.getByRole("main").getByRole("link", { name: "Academic Years" })).toBeVisible();
  await audit(page);
});

test("navigation offers Courses and Class Offerings only to a School Administrator", async ({ page }) => {
  const { faculty, schools } = seeded();
  await signIn(page, faculty);
  const nav = page.getByRole("navigation");
  await expect(nav).toBeVisible();
  await expect(nav.getByRole("link", { name: "Courses" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Class Offerings" })).toHaveCount(0);

  // And opened from their URLs anyway, each page is the one refusal.
  const schoolId = await schoolIdOf(page, schools[0]!);
  for (const path of ["courses", "class-offerings", `class-offerings/${randomUUID()}`]) {
    await page.goto(`/schools/${schoolId}/${path}`);
    await expect(page.getByRole("heading", { level: 1, name: "Not available" })).toBeVisible();
  }
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`each page holds 360px in the ${colorScheme} rendition`, async ({ page, audit }) => {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      const { schoolId, term } = await withOwnTerm(page);
      const course = await arrangeCourse(page, schoolId, `C-${randomUUID().slice(0, 6)}`);
      const { classOffering } = await arrange<{ classOffering: { id: string } }>(page, schoolId, "/class-offerings", {
        courseId: course.id,
        termId: term.id,
        label: "A label long enough to wrap on a narrow sheet",
      });

      for (const path of ["courses", "class-offerings", `class-offerings/${classOffering.id}`]) {
        await page.goto(`/schools/${schoolId}/${path}`);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        if (path === "class-offerings") {
          await page.getByLabel("Term").selectOption({ label: term.option });
          // Stacked at this width, the record's own head row is dropped.
          await expect(recordRows(page, `Class Offerings in ${term.name}`)).toHaveCount(1);
        }
        await expectNoSidewaysScroll(page);
        await audit(page);
      }
    });
  }
});

