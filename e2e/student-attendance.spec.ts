import { arrange, arrangePerson, darken, invitationFor, recordRows, redeem, withAttendanceOffering } from "./app.ts";
import { expect, expectNoSidewaysScroll, test } from "./test.ts";

/**
 * A Student's own Attendance, on Your attendance, and a Guardian's view of it
 * on their account: shown for the linked Student whose link grants attendance
 * read, and nothing at all for the one whose link does not. Who may read what
 * is the HTTP suite's to assert; this is about the pages showing it.
 *
 * Arranged in the Attendance specs' own School: see withAttendanceOffering.
 */
test("a Student reads their own Attendance, and a Guardian each linked Student's their link permits", async ({
  page,
  audit,
  playwright,
}) => {
  const { schoolId, classOfferingId, courseName, token } = await withAttendanceOffering(page);
  const origin = new URL(page.url()).origin;
  const permitted = `Parker ${token}`;
  const withheld = `Quinn ${token}`;
  const studentIds: string[] = [];
  for (const name of [permitted, withheld]) {
    const personId = await arrangePerson(page, schoolId, name, ["student"]);
    await arrange(page, schoolId, "/enrollments", { studentPersonId: personId });
    studentIds.push(personId);
  }
  await arrange(page, schoolId, `/class-offerings/${classOfferingId}/roster-memberships`, { personIds: studentIds });
  const teacherId = await arrangePerson(page, schoolId, `Teagan ${token}`, ["faculty"]);
  await arrange(page, schoolId, `/class-offerings/${classOfferingId}/teaching-assignments`, { personId: teacherId });
  const guardianId = await arrangePerson(page, schoolId, `Gemma ${token}`, ["guardian"]);
  for (const [studentPersonId, attendanceRead] of [
    [studentIds[0]!, true],
    [studentIds[1]!, false],
  ] as const) {
    await arrange(page, schoolId, "/guardian-links", {
      guardianPersonId: guardianId,
      studentPersonId,
      accessProfile: { attendanceRead, resultsRead: false },
    });
  }
  const teacherInvitation = await invitationFor(page, schoolId, teacherId, `teagan-${token}`);
  const studentInvitation = await invitationFor(page, schoolId, studentIds[0]!, `parker-${token}`);
  const guardianInvitation = await invitationFor(page, schoolId, guardianId, `gemma-${token}`);

  // The Faculty member marks the School's today, read from its session, in a browser of their own.
  const teacherBrowser = await playwright.request.newContext({ baseURL: origin });
  await redeem(teacherBrowser, origin, teacherInvitation);
  const session = await teacherBrowser.get(`/api/schools/${schoolId}/class-offerings/${classOfferingId}/attendance-session`);
  const { attendanceSession } = (await session.json()) as { attendanceSession: { date: string } };
  const saved = await teacherBrowser.patch(`/api/schools/${schoolId}/class-offerings/${classOfferingId}/attendance-session`, {
    headers: { origin },
    data: {
      date: attendanceSession.date,
      marks: [
        { studentPersonId: studentIds[0], loaded: null, status: "tardy" },
        { studentPersonId: studentIds[1], loaded: null, status: "present" },
      ],
    },
  });
  expect(saved.ok()).toBe(true);
  await teacherBrowser.dispose();

  // Class Offering, then Present, Tardy, Excused absence, Unexcused absence, Absent pending review, and Not recorded.
  const counted = /^\d+$/;
  const tardyTotals = [courseName, "0", "1", "0", "0", "0", counted];

  // The Student opens Your attendance from the navigation, and today's mark under its totals from the keyboard.
  await redeem(page.request, origin, studentInvitation);
  await page.goto(`/schools/${schoolId}/account`);
  await page.getByRole("link", { name: "Your attendance" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your attendance" })).toBeVisible();
  const ownTotals = page.getByRole("table", { name: /^Parker .*Attendance totals in / });
  await expect(ownTotals.getByRole("row").filter({ hasText: courseName }).getByRole("cell")).toHaveText(tardyTotals);
  await expect(page.getByRole("main")).not.toContainText(withheld);
  const days = page.getByText(/^Each day marked in /);
  await days.focus();
  await page.keyboard.press("Enter");
  const marked = page.getByRole("table", { name: /^Parker .*Attendance by date in / });
  await expect(marked.getByRole("row").filter({ hasText: courseName })).toContainText("Tardy");
  await audit(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await expectNoSidewaysScroll(page);
  await audit(page);
  await darken(page);
  await expectNoSidewaysScroll(page);
  await audit(page);

  // The Guardian's account shows the permitted Student's Attendance, and nothing of the other's.
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await redeem(page.request, origin, guardianInvitation);
  await page.goto(`/schools/${schoolId}/account`);
  await expect(page.getByRole("heading", { level: 2, name: "Attendance", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: permitted })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: withheld })).toHaveCount(0);
  const guardianTotals = page.getByRole("table", { name: /^Parker .*Attendance totals in / });
  await expect(guardianTotals.getByRole("row").filter({ hasText: courseName }).getByRole("cell")).toHaveText(tardyTotals);
  // Only a Student rostered in it opens the Class Offering's own page.
  await expect(guardianTotals.getByRole("link")).toHaveCount(0);
  await expect(recordRows(page, "Students you are linked to").filter({ hasText: withheld })).toContainText("May not read");
  await audit(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await expectNoSidewaysScroll(page);
  await audit(page);
  await darken(page);
  await expectNoSidewaysScroll(page);
  await audit(page);
});
