import { arrange, arrangePerson, darken, invitationFor, recordRows, redeem, signIn, withAttendanceOffering } from "./app.ts";
import { seeded } from "./seeded.ts";
import { expect, expectNoSidewaysScroll, test } from "./test.ts";

/**
 * Correction requests for Term results: a Faculty member requesting a change
 * to a published result beside its Student, then a School Administrator
 * approving it from the queue, which shows each of the value, score and
 * comment before and after, and the Term report showing the change at once.
 * Which requests are refused, and what is audited, is the HTTP suite's to
 * assert; this is about the pages doing it and saying what they did.
 *
 * Arranged in the Attendance specs' own School: see withAttendanceOffering.
 */

test("a Faculty member requests a correction to a published result, and a School Administrator approves it", async ({
  page,
  audit,
}) => {
  const { schoolId, classOfferingId, courseName, token } = await withAttendanceOffering(page);
  const origin = new URL(page.url()).origin;
  const student = `Parker ${token}`;
  const studentId = await arrangePerson(page, schoolId, student, ["student"]);
  await arrange(page, schoolId, "/enrollments", { studentPersonId: studentId });
  await arrange(page, schoolId, `/class-offerings/${classOfferingId}/roster-memberships`, { personIds: [studentId] });
  const teacherId = await arrangePerson(page, schoolId, `Teagan ${token}`, ["faculty"]);
  await arrange(page, schoolId, `/class-offerings/${classOfferingId}/teaching-assignments`, { personId: teacherId });
  const teacherInvitation = await invitationFor(page, schoolId, teacherId, `teagan-${token}`);

  // The Faculty member signs in, publishes a B, and opens the class's Term
  // results, where the published result offers a correction.
  await redeem(page.request, origin, teacherInvitation);
  const offering = `/api/schools/${schoolId}/class-offerings/${classOfferingId}`;
  const drafted = await page.request.patch(`${offering}/term-results`, {
    headers: { origin },
    data: { drafts: [{ studentPersonId: studentId, loaded: null, value: "B", score: 84, comment: "Steady all Term." }] },
  });
  expect(drafted.ok()).toBe(true);
  expect((await page.request.post(`${offering}/publications`, { headers: { origin }, data: {} })).ok()).toBe(true);
  await page.goto(`/schools/${schoolId}/class-offerings/${classOfferingId}/term-results`);
  await expect(page.getByRole("heading", { level: 1, name: courseName })).toBeVisible();
  await page.getByRole("button", { name: `Request a correction for ${student}` }).click();
  const dialog = page.getByRole("dialog", { name: `Request a correction for ${student}?` });
  await expect(dialog).toContainText("value B, score 84, comment Steady all Term.");
  await expect(dialog).toContainText("it is made only once approved");
  // Nothing to send until something changes and a reason is given.
  await expect(dialog.getByRole("button", { name: "Request the correction" })).toBeDisabled();
  await audit(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await expectNoSidewaysScroll(page);
  await darken(page);
  await expectNoSidewaysScroll(page);
  await audit(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });

  // The value and score change, the comment stays; the reason and request go from the keyboard.
  await dialog.getByLabel("Value").selectOption("A");
  await dialog.getByLabel(/^Score/).fill("91");
  await dialog.getByLabel("Reason").focus();
  await page.keyboard.type("The final paper was marked against the wrong key");
  // Past Cancel, to the control that goes ahead.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Request the correction" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Correction request" })).toHaveText(
    `Your Correction request for ${student} is pending.`,
  );
  // Nothing changes until it is approved.
  await expect(recordRows(page, "Term results").filter({ hasText: student })).toContainText("84");

  // Their own requests: the result request marked by kind, each part before and after.
  await page.getByRole("link", { name: "Correction requests" }).last().click();
  await expect(page.getByRole("heading", { level: 1, name: "Correction requests" })).toBeVisible();
  const pending = () => recordRows(page, "Pending Correction requests").filter({ hasText: token });
  await expect(pending()).toHaveCount(1);
  await expect(pending()).toContainText("Term result");
  await expect(pending()).toContainText("B to A");
  await expect(pending()).toContainText("84 to 91");
  await expect(pending()).toContainText("Steady all Term., unchanged");
  await audit(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await expectNoSidewaysScroll(page);
  await darken(page);
  await expectNoSidewaysScroll(page);
  await audit(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });

  // The School Administrator approves it from the queue.
  await page.context().clearCookies();
  await signIn(page, seeded().schoolAdministrator);
  await expect(page).toHaveURL(/\/schools/);
  await page.goto(`/schools/${schoolId}/correction-requests`);
  await pending().getByRole("button", { name: /^Approve/ }).click();
  const approving = page.getByRole("dialog", { name: `Approve ${student}’s correction?` });
  await expect(approving).toContainText(
    "changes from value B, score 84, comment Steady all Term. to value A, score 91, comment Steady all Term. at once",
  );
  await audit(page);
  await approving.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("status")).toHaveText(`${student}’s request is approved.`);
  await expect(recordRows(page, "Decided Correction requests").filter({ hasText: token })).toContainText("Approved");

  // The Term report shows the corrected result at once.
  await page.goto(`/schools/${schoolId}/persons/${studentId}/term-report`);
  const row = page.getByRole("table", { name: /Term report for / }).getByRole("row").filter({ hasText: courseName });
  await expect(row).toContainText("A");
  await expect(row).toContainText("91");
  await expect(row).not.toContainText("84");
});
