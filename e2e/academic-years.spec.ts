import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { arrange, changesSent, openSchool, openSection, recordRows, schoolIdOf, signIn } from "./app.ts";
import { seeded } from "./seeded.ts";
import { expect, expectNoSidewaysScroll, test } from "./test.ts";

/**
 * Academic Years: where a School Administrator plans the School's calendar.
 * Which sets of Terms cover a year is the HTTP suite's to assert; this is
 * about the page building one, saying why it refuses one, and deleting one
 * only once confirmed.
 *
 * Years are built in the first seeded School, each test in a year of its own
 * far enough ahead that no other test's can overlap it. The second seeded
 * School is left without one: School settings changes its timezone, which a
 * year would fix.
 */

interface Year {
  schoolId: string;
  id: string;
  name: string;
  /** The calendar year it starts in. */
  starts: number;
}

/** A year of this test's own: September to June, somewhere no other test's falls. */
function yearOfOwn(): { name: string; starts: number; firstDate: string; lastDate: string } {
  const starts = 2100 + Math.floor(Math.random() * 7000);
  return {
    name: `Year ${randomUUID().slice(0, 8)}`,
    starts,
    firstDate: `${starts}-09-01`,
    lastDate: `${starts + 1}-06-30`,
  };
}

/** A School Administrator on the first School's Academic Years. */
async function onAcademicYears(page: Page): Promise<{ schoolId: string }> {
  const { schoolAdministrator, schools } = seeded();
  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[0]!);
  const schoolId = await schoolIdOf(page, schools[0]!);
  await openSection(page, "Academic Years");
  await expect(page.getByRole("heading", { level: 1, name: "Academic Years" })).toBeVisible();
  return { schoolId };
}

/** A year arranged through the API, optionally divided into halves at the new year. */
async function arrangeYear(page: Page, schoolId: string, { divided }: { divided: boolean }): Promise<Year> {
  const own = yearOfOwn();
  const { academicYear } = await arrange<{ academicYear: { id: string } }>(page, schoolId, "/academic-years", {
    name: own.name,
    firstDate: own.firstDate,
    lastDate: own.lastDate,
  });
  if (divided) {
    const response = await page.request.patch(`/api/schools/${schoolId}/academic-years/${academicYear.id}`, {
      headers: { origin: new URL(page.url()).origin },
      data: {
        terms: [
          { name: "Fall", firstDate: own.firstDate, lastDate: `${own.starts + 1}-01-15` },
          { name: "Spring", firstDate: `${own.starts + 1}-01-16`, lastDate: own.lastDate },
        ],
      },
    });
    expect(response.ok()).toBe(true);
  }
  await page.reload();
  return { schoolId, id: academicYear.id, name: own.name, starts: own.starts };
}

/** The Terms of a year as the server holds them. */
async function termsHeld(page: Page, year: Year) {
  const { academicYears } = (await (await page.request.get(`/api/schools/${year.schoolId}/academic-years`)).json()) as {
    academicYears: { id: string; terms: { name: string; firstDate: string; lastDate: string }[] }[];
  };
  return academicYears.find((each) => each.id === year.id)?.terms.map(({ name, firstDate, lastDate }) => ({
    name,
    firstDate,
    lastDate,
  }));
}

/** One Term's fields in the open editor, by its place in the year. */
function termDraft(editor: Locator, place: number) {
  return editor.getByRole("group", { name: `Term ${place}`, exact: true });
}

test("an Academic Year is built with Terms, its boundary moved in one change, and the timezone then fixed", async ({
  page,
  audit,
}) => {
  const { schoolId } = await onAcademicYears(page);
  const own = yearOfOwn();

  const create = page.getByRole("form", { name: "Create an Academic Year" });
  await create.getByLabel("Name").fill(own.name);
  await create.getByLabel("First day").fill(own.firstDate);
  await create.getByLabel("Last day").fill(own.lastDate);
  await create.getByRole("button", { name: "Create Academic Year" }).click();
  const record = page.getByRole("region", { name: own.name });
  await expect(record).toContainText("Not yet divided");
  await expect(page.getByRole("status")).toHaveText(`${own.name} is created. Divide it into Terms with Change.`);

  // Divide it in two: the first Term takes the whole year until a second is added.
  await page.getByRole("button", { name: `Change ${own.name}` }).click();
  const editor = page.getByRole("form", { name: `Change ${own.name}` });
  await expect(editor.getByLabel("Name", { exact: true }).first()).toBeFocused();
  await editor.getByRole("button", { name: "Add a Term" }).click();
  await termDraft(editor, 1).getByLabel("Name").fill("Fall");
  await expect(termDraft(editor, 1).getByLabel("First day")).toHaveValue(own.firstDate);
  await expect(termDraft(editor, 1).getByLabel("Last day")).toHaveValue(own.lastDate);
  await editor.getByRole("button", { name: "Add a Term" }).click();
  await termDraft(editor, 1).getByLabel("Last day").fill(`${own.starts + 1}-01-15`);
  await expect(termDraft(editor, 2).getByLabel("First day")).toHaveValue(`${own.starts + 1}-01-16`);
  await expect(termDraft(editor, 2).getByLabel("Last day")).toHaveValue(own.lastDate);
  await termDraft(editor, 2).getByLabel("Name").fill("Spring");
  await audit(page);
  await editor.getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByRole("status")).toHaveText(`${own.name} is saved.`);
  const terms = recordRows(page, `Terms of ${own.name}`);
  await expect(terms).toHaveCount(3);
  await expect(terms.nth(1)).toContainText("Fall");
  await expect(terms.nth(2)).toContainText("Spring");
  const year: Year = { schoolId, id: "", name: own.name, starts: own.starts };
  const { academicYears } = (await (await page.request.get(`/api/schools/${schoolId}/academic-years`)).json()) as {
    academicYears: { id: string; name: string }[];
  };
  year.id = academicYears.find((each) => each.name === own.name)!.id;
  expect(await termsHeld(page, year)).toEqual([
    { name: "Fall", firstDate: own.firstDate, lastDate: `${own.starts + 1}-01-15` },
    { name: "Spring", firstDate: `${own.starts + 1}-01-16`, lastDate: own.lastDate },
  ]);

  // Moving the boundary between them is one edit, sent as one change.
  await page.getByRole("button", { name: `Change ${own.name}` }).click();
  await termDraft(editor, 1).getByLabel("Last day").fill(`${own.starts + 1}-01-22`);
  await expect(termDraft(editor, 2).getByLabel("First day")).toHaveValue(`${own.starts + 1}-01-23`);
  const sent = changesSent(page);
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toHaveText(`${own.name} is saved.`);
  expect(sent).toEqual([`PATCH /api/schools/${schoolId}/academic-years/${year.id}`]);
  expect(await termsHeld(page, year)).toEqual([
    { name: "Fall", firstDate: own.firstDate, lastDate: `${own.starts + 1}-01-22` },
    { name: "Spring", firstDate: `${own.starts + 1}-01-23`, lastDate: own.lastDate },
  ]);

  // The School's timezone is fixed now, and its settings say why.
  await openSection(page, "Settings");
  await expect(page.getByRole("heading", { level: 2, name: "The timezone is fixed" })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("This School has an Academic Year");
  await expect(page.getByRole("form", { name: "Change the timezone" })).toHaveCount(0);
});

test("Terms that would leave a gap are refused, saying why, and change nothing", async ({ page, audit }) => {
  const { schoolId } = await onAcademicYears(page);
  const year = await arrangeYear(page, schoolId, { divided: true });
  const before = await termsHeld(page, year);

  await page.getByRole("button", { name: `Change ${year.name}` }).click();
  const editor = page.getByRole("form", { name: `Change ${year.name}` });
  await termDraft(editor, 2).getByLabel("First day").fill(`${year.starts + 1}-02-01`);
  await editor.getByRole("button", { name: "Save changes" }).click();

  await expect(editor.getByRole("alert")).toContainText("The Terms leave days of the year in no Term.");
  await audit(page);
  expect(await termsHeld(page, year)).toEqual(before);

  // Cancelling puts the year back as it was, with the focus on the control that opened it.
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: `Change ${year.name}` })).toBeFocused();
});

test("a year overlapping another is refused, saying why", async ({ page }) => {
  const { schoolId } = await onAcademicYears(page);
  const year = await arrangeYear(page, schoolId, { divided: false });

  const create = page.getByRole("form", { name: "Create an Academic Year" });
  await create.getByLabel("Name").fill(`Overlapping ${year.name}`);
  await create.getByLabel("First day").fill(`${year.starts + 1}-06-30`);
  await create.getByLabel("Last day").fill(`${year.starts + 2}-06-30`);
  await create.getByRole("button", { name: "Create Academic Year" }).click();

  await expect(create.getByRole("alert")).toContainText("share a day with another Academic Year");
  await expect(page.getByRole("region", { name: `Overlapping ${year.name}` })).toHaveCount(0);
});

test("a cancelled deletion changes nothing, and a confirmed one removes the year", async ({ page, audit }) => {
  const { schoolId } = await onAcademicYears(page);
  const year = await arrangeYear(page, schoolId, { divided: false });
  const sent = changesSent(page);

  await page.getByRole("button", { name: `Delete ${year.name}` }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(`${year.name}, from`);
  await expect(dialog).toContainText("Nothing else refers to it yet.");
  await audit(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(sent).toEqual([]);
  await expect(page.getByRole("region", { name: year.name })).toBeVisible();

  await page.getByRole("button", { name: `Delete ${year.name}` }).click();
  await dialog.getByRole("button", { name: "Delete the Academic Year" }).click();
  await expect(page.getByRole("status")).toHaveText(`${year.name} is deleted.`);
  await expect(page.getByRole("region", { name: year.name })).toHaveCount(0);
  expect(sent).toEqual([`DELETE /api/schools/${schoolId}/academic-years/${year.id}`]);
});

test("a year with Terms is not deleted, and the page says to remove its Terms first", async ({ page }) => {
  const { schoolId } = await onAcademicYears(page);
  const year = await arrangeYear(page, schoolId, { divided: true });

  await page.getByRole("button", { name: `Delete ${year.name}` }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("is divided into 2 Terms");
  await dialog.getByRole("button", { name: "Delete the Academic Year" }).click();

  const record = page.getByRole("region", { name: year.name });
  await expect(record.getByRole("alert")).toContainText("This year still has Terms");
  await expect(recordRows(page, `Terms of ${year.name}`)).toHaveCount(3);
});

test("a School with no Academic Year says so, and offers to create the first", async ({ page, audit }) => {
  const { schoolAdministrator, schools } = seeded();
  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[1]!);
  await openSection(page, "Academic Years");

  await expect(page.getByRole("main")).toContainText("This School has no Academic Year yet.");
  await expect(page.getByRole("form", { name: "Create an Academic Year" })).toBeVisible();
  await audit(page);
});

test("navigation offers Academic Years only to a School Administrator", async ({ page }) => {
  const { faculty, schools } = seeded();
  await signIn(page, faculty);
  await expect(page.getByRole("navigation")).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("link", { name: "Academic Years" })).toHaveCount(0);

  // And opened from its URL anyway, the page is the one refusal.
  const schoolId = await schoolIdOf(page, schools[0]!);
  await page.goto(`/schools/${schoolId}/academic-years`);
  await expect(page.getByRole("heading", { level: 1, name: "Not available" })).toBeVisible();
});

test("the page opens from its URL", async ({ page }) => {
  const { schoolId } = await onAcademicYears(page);

  await page.goto(`/schools/${schoolId}/academic-years`);

  await expect(page.getByRole("heading", { level: 1, name: "Academic Years" })).toBeVisible();
});

test("a year is changed from the keyboard alone, with focus in sight", async ({ page }) => {
  const { schoolId } = await onAcademicYears(page);
  const year = await arrangeYear(page, schoolId, { divided: true });
  const change = page.getByRole("button", { name: `Change ${year.name}` });

  await change.focus();
  await page.keyboard.press("Enter");
  const editor = page.getByRole("form", { name: `Change ${year.name}` });
  const name = editor.getByLabel("Name", { exact: true }).first();
  await expect(name).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(`${year.name} renamed`);

  const save = editor.getByRole("button", { name: "Save changes" });
  await save.focus();
  expect(await save.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe("none");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("status")).toHaveText(`${year.name} renamed is saved.`);
  await expect(page.getByRole("button", { name: `Change ${year.name} renamed` })).toBeFocused();
});

/** The days from `first` to `last` falling on these ISO weekdays (1 is Monday), counted. */
function daysOn(first: string, last: string, weekdays: number[]): number {
  let count = 0;
  for (const day = new Date(`${first}T00:00:00Z`); day <= new Date(`${last}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) {
    count += weekdays.includes(((day.getUTCDay() + 6) % 7) + 1) ? 1 : 0;
  }
  return count;
}

/** The first date on or after `from` falling on this ISO weekday. */
function firstOn(from: string, weekday: number): string {
  const day = new Date(`${from}T00:00:00Z`);
  while (((day.getUTCDay() + 6) % 7) + 1 !== weekday) {
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return day.toISOString().slice(0, 10);
}

/** One day of a year's calendar, by its School date. */
function dayIn(page: Page, year: Year, date: string) {
  return page.getByRole("region", { name: year.name }).locator(`button[data-date="${date}"]`);
}

test("a weekday pattern is set, a holiday and a make-up day are added, and the Term's count follows", async ({
  page,
  audit,
}) => {
  const { schoolId } = await onAcademicYears(page);
  const year = await arrangeYear(page, schoolId, { divided: true });
  const fall = { firstDate: `${year.starts}-09-01`, lastDate: `${year.starts + 1}-01-15` };
  const fallRow = recordRows(page, `Terms of ${year.name}`).nth(1);
  await expect(fallRow).toContainText(`${daysOn(fall.firstDate, fall.lastDate, [1, 2, 3, 4, 5])} Instructional days`);

  // Four-day weeks: Friday is no longer a school day.
  const pattern = page.getByRole("form", { name: `Weekday pattern of ${year.name}` });
  await pattern.getByLabel("Friday").uncheck();
  await pattern.getByRole("button", { name: "Save the pattern" }).click();
  await expect(page.getByRole("status")).toHaveText(`The weekday pattern of ${year.name} is saved.`);
  const fourDays = daysOn(fall.firstDate, fall.lastDate, [1, 2, 3, 4]);
  await expect(fallRow).toContainText(`${fourDays} Instructional days`);

  // The year's first Monday taken out, and its first Saturday put in.
  const holiday = firstOn(fall.firstDate, 1);
  await dayIn(page, year, holiday).click();
  await expect(dayIn(page, year, holiday)).toHaveAccessibleName(/: Instructional day$/);
  await page.getByRole("button", { name: "Take it out as a holiday" }).click();
  await expect(page.getByRole("status")).toContainText("is taken out as a holiday.");
  await expect(dayIn(page, year, holiday)).toHaveAccessibleName(/: holiday, taken out$/);
  await expect(fallRow).toContainText(`${fourDays - 1} Instructional days`);

  const makeUp = firstOn(fall.firstDate, 6);
  await dayIn(page, year, makeUp).click();
  await page.getByRole("button", { name: "Put it in as a make-up day" }).click();
  await expect(page.getByRole("status")).toContainText("is put in as a make-up day.");
  await expect(dayIn(page, year, makeUp)).toHaveAccessibleName(/: make-up day, put in$/);
  await expect(fallRow).toContainText(`${fourDays} Instructional days`);
  await audit(page);

  const { academicYears } = (await (await page.request.get(`/api/schools/${schoolId}/academic-years`)).json()) as {
    academicYears: { id: string; weekdays: string[]; exceptions: { date: string; instructional: boolean }[] }[];
  };
  const held = academicYears.find((each) => each.id === year.id)!;
  expect(held.weekdays).toEqual(["monday", "tuesday", "wednesday", "thursday"]);
  // Listed in date order, whichever was added first.
  expect(held.exceptions.map(({ date, instructional }) => ({ date, instructional }))).toEqual(
    [
      { date: holiday, instructional: false },
      { date: makeUp, instructional: true },
    ].sort((a, b) => a.date.localeCompare(b.date)),
  );

  // Returned to the pattern, the holiday is a school day again.
  await dayIn(page, year, holiday).click();
  await page.getByRole("button", { name: "Return it to the weekday pattern" }).click();
  await expect(page.getByRole("status")).toContainText("is returned to the weekday pattern.");
  await expect(fallRow).toContainText(`${fourDays + 1} Instructional days`);
});

test("the calendar is worked from the keyboard alone, with focus in sight", async ({ page }) => {
  const { schoolId } = await onAcademicYears(page);
  const year = await arrangeYear(page, schoolId, { divided: false });
  const first = `${year.starts}-09-01`;
  const region = page.getByRole("region", { name: year.name });

  // The grid is one stop in the Tab order: its first day, until another is moved to.
  const opening = dayIn(page, year, first);
  await expect(region.locator('button[data-date][tabindex="0"]')).toHaveCount(1);
  await opening.focus();
  expect(await opening.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe("none");

  await page.keyboard.press("ArrowRight");
  await expect(dayIn(page, year, `${year.starts}-09-02`)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(dayIn(page, year, `${year.starts}-09-09`)).toBeFocused();
  // Going before the year's first day stays on it.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(opening).toBeFocused();
  await page.keyboard.press("PageDown");
  await expect(dayIn(page, year, `${year.starts}-10-01`)).toBeFocused();
  await expect(region.getByRole("heading", { level: 4 })).toContainText(`${year.starts}`);

  // Choosing a day offers its one change, reached with Tab.
  const saturday = firstOn(`${year.starts}-10-01`, 6);
  while (!(await dayIn(page, year, saturday).evaluate((node) => node === document.activeElement))) {
    await page.keyboard.press("ArrowRight");
  }
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  const putIn = page.getByRole("button", { name: "Put it in as a make-up day" });
  await expect(putIn).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("status")).toContainText("is put in as a make-up day.");
  await expect(page.getByRole("button", { name: "Return it to the weekday pattern" })).toBeFocused();
});

test("a year with a day taken out is not deleted, and the page says to return it first", async ({ page }) => {
  const { schoolId } = await onAcademicYears(page);
  const year = await arrangeYear(page, schoolId, { divided: false });
  await dayIn(page, year, firstOn(`${year.starts}-09-01`, 1)).click();
  await page.getByRole("button", { name: "Take it out as a holiday" }).click();
  await expect(page.getByRole("status")).toContainText("is taken out as a holiday.");

  await page.getByRole("button", { name: `Delete ${year.name}` }).click();
  const dialog = page.getByRole("dialog", { name: `Delete ${year.name}?` });
  await expect(dialog).toContainText("return each to the weekday pattern first");
  await dialog.getByRole("button", { name: "Delete the Academic Year" }).click();

  await expect(page.getByRole("region", { name: year.name }).getByRole("alert")).toContainText(
    "Return each to the weekday pattern first.",
  );
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the sheet and its editor hold 360px in the ${colorScheme} rendition`, async ({ page, audit }) => {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      const { schoolId } = await onAcademicYears(page);
      const year = await arrangeYear(page, schoolId, { divided: true });
      await expectNoSidewaysScroll(page);
      await audit(page);

      // A day chosen in the calendar, with the change it offers.
      const day = dayIn(page, year, firstOn(`${year.starts}-09-01`, 1));
      await day.scrollIntoViewIfNeeded();
      await day.click();
      await expect(page.getByRole("button", { name: "Take it out as a holiday" })).toBeInViewport();
      await expectNoSidewaysScroll(page);
      await audit(page);

      await page.getByRole("button", { name: `Change ${year.name}` }).click();
      const save = page.getByRole("button", { name: "Save changes" });
      await save.scrollIntoViewIfNeeded();
      await expect(save).toBeInViewport();
      await expectNoSidewaysScroll(page);
      await audit(page);
    });
  }
});
