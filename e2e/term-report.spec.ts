import type { Page } from "@playwright/test";
import { arrange, arrangePerson, darken, invitationFor, redeem, withAttendanceOffering } from "./app.ts";
import { expect, expectNoSidewaysScroll, test } from "./test.ts";

/**
 * The Term report: a Student reading their own from the navigation, a
 * Guardian whose link grants attendance read alone reading a linked Student's
 * from their account with nothing in place of the results withheld, and the
 * print rendition, which carries the record and nothing else. Who may read
 * which parts is the HTTP suite's to assert; this is about the pages.
 *
 * Arranged in the Attendance specs' own School: see withAttendanceOffering.
 */

/** Checks the page as printed: the record alone, with no shell, navigation, key or control. */
async function expectPrintsClean(page: Page, heading: string): Promise<void> {
  await page.emulateMedia({ media: "print" });
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  await expect(page.getByRole("table", { name: /Term report for / })).toBeVisible();
  for (const hidden of [
    page.locator(".sheet__head"),
    page.locator("aside.legend"),
    page.getByRole("navigation"),
    page.getByRole("button", { name: "Print" }),
  ]) {
    await expect(hidden).toBeHidden();
  }
  await page.emulateMedia({ media: "screen" });
}

test("a Student reads their own Term report, and a Guardian without results read reads a linked Student's totals alone", async ({
  page,
  audit,
  playwright,
}) => {
  const { schoolId, classOfferingId, courseName, token } = await withAttendanceOffering(page);
  const origin = new URL(page.url()).origin;
  const student = `Parker ${token}`;
  const studentId = await arrangePerson(page, schoolId, student, ["student"]);
  await arrange(page, schoolId, "/enrollments", { studentPersonId: studentId });
  await arrange(page, schoolId, `/class-offerings/${classOfferingId}/roster-memberships`, { personIds: [studentId] });
  const teacherId = await arrangePerson(page, schoolId, `Teagan ${token}`, ["faculty"]);
  await arrange(page, schoolId, `/class-offerings/${classOfferingId}/teaching-assignments`, { personId: teacherId });
  const guardianId = await arrangePerson(page, schoolId, `Gemma ${token}`, ["guardian"]);
  await arrange(page, schoolId, "/guardian-links", {
    guardianPersonId: guardianId,
    studentPersonId: studentId,
    accessProfile: { attendanceRead: true, resultsRead: false },
  });
  const teacherInvitation = await invitationFor(page, schoolId, teacherId, `teagan-${token}`);
  const studentInvitation = await invitationFor(page, schoolId, studentId, `parker-${token}`);
  const guardianInvitation = await invitationFor(page, schoolId, guardianId, `gemma-${token}`);

  // The Faculty member, in a browser of their own, marks the School's today and publishes a B.
  const teacherBrowser = await playwright.request.newContext({ baseURL: origin });
  await redeem(teacherBrowser, origin, teacherInvitation);
  const offering = `/api/schools/${schoolId}/class-offerings/${classOfferingId}`;
  const session = await teacherBrowser.get(`${offering}/attendance-session`);
  const { attendanceSession } = (await session.json()) as { attendanceSession: { date: string } };
  const marked = await teacherBrowser.patch(`${offering}/attendance-session`, {
    headers: { origin },
    data: { date: attendanceSession.date, marks: [{ studentPersonId: studentId, loaded: null, status: "tardy" }] },
  });
  expect(marked.ok()).toBe(true);
  const drafted = await teacherBrowser.patch(`${offering}/term-results`, {
    headers: { origin },
    data: { drafts: [{ studentPersonId: studentId, loaded: null, value: "B", score: 84, comment: "Steady all Term." }] },
  });
  expect(drafted.ok()).toBe(true);
  expect((await teacherBrowser.post(`${offering}/publications`, { headers: { origin }, data: {} })).ok()).toBe(true);
  await teacherBrowser.dispose();

  const report = () => page.getByRole("table", { name: /Term report for / });
  const row = () => report().getByRole("row").filter({ hasText: courseName });
  const counted = /^\d+$/;

  // The Student opens Your Term report from the navigation.
  await redeem(page.request, origin, studentInvitation);
  await page.goto(`/schools/${schoolId}/account`);
  await page.getByRole("link", { name: "Your Term report" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your Term report" })).toBeVisible();
  // Class Offering, the Term result, score and comment, then each Attendance total.
  await expect(row().getByRole("cell")).toHaveText([
    courseName,
    "B",
    "84",
    "Steady all Term.",
    "0",
    "1",
    "0",
    "0",
    "0",
    counted,
  ]);
  await audit(page);
  await page.getByRole("button", { name: "Print" }).focus();
  await expect(page.getByRole("button", { name: "Print" })).toBeFocused();
  await expectPrintsClean(page, "Your Term report");
  await page.setViewportSize({ width: 360, height: 800 });
  await expectNoSidewaysScroll(page);
  await audit(page);
  await darken(page);
  await expectNoSidewaysScroll(page);
  await audit(page);

  // The Guardian opens the linked Student's from their account, and is shown the totals alone.
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await redeem(page.request, origin, guardianInvitation);
  await page.goto(`/schools/${schoolId}/account`);
  await expect(page.getByRole("main").getByText(/not built yet/)).toHaveCount(0);
  await page.getByRole("link", { name: `${student}’s Term report` }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Term report" })).toBeVisible();
  await expect(row().getByRole("cell")).toHaveText([courseName, "0", "1", "0", "0", "0", counted]);
  // Nothing marks the results withheld: no column, key or word for them.
  await expect(page.getByRole("main")).not.toContainText(/Term result|None published|Steady/);
  await expect(page.locator("aside.legend")).not.toContainText("Term result");
  await audit(page);
  await expectPrintsClean(page, "Term report");
  await page.setViewportSize({ width: 360, height: 800 });
  await expectNoSidewaysScroll(page);
  await audit(page);
  await darken(page);
  await expectNoSidewaysScroll(page);
  await audit(page);
});
