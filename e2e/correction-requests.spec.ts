import { arrange, arrangePerson, darken, invitationFor, recordRows, redeem, signIn, withAttendanceOffering } from "./app.ts";
import { seeded } from "./seeded.ts";
import { expect, expectNoSidewaysScroll, test } from "./test.ts";

/**
 * Correction requests: a Faculty member raising them beside each Student on a
 * day whose Attendance window has closed and nobody took, and withdrawing
 * one; then a School Administrator approving one, which changes the
 * Attendance at once, and rejecting another with a reason. Who may do which,
 * and what is audited, is the HTTP suite's to assert; this is about the pages
 * doing it and saying what they did.
 *
 * Arranged in the Attendance specs' own School: see withAttendanceOffering.
 */

/** The School date `days` from today, as the browser's clock has it. */
function day(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

test("a Faculty member raises and withdraws Correction requests, and a School Administrator approves and rejects them", async ({
  page,
  audit,
}) => {
  const { schoolId, classOfferingId, courseName, token, term } = await withAttendanceOffering(page);
  const origin = new URL(page.url()).origin;
  const approved = `Parker ${token}`;
  const rejected = `Quinn ${token}`;
  const studentIds: string[] = [];
  for (const name of [approved, rejected]) {
    const personId = await arrangePerson(page, schoolId, name, ["student"]);
    await arrange(page, schoolId, "/enrollments", { studentPersonId: personId });
    studentIds.push(personId);
  }
  await arrange(page, schoolId, `/class-offerings/${classOfferingId}/roster-memberships`, { personIds: studentIds });
  const teacher = `Teagan ${token}`;
  const teacherId = await arrangePerson(page, schoolId, teacher, ["faculty"]);
  await arrange(page, schoolId, `/class-offerings/${classOfferingId}/teaching-assignments`, { personId: teacherId });
  const invitation = await invitationFor(page, schoolId, teacherId, `teagan-${token}`);
  // Ten days ago: past the default seven-day window, and nobody took it.
  const closed = [day(-10), term.firstDate].sort().at(-1)!;
  const rows = () => recordRows(page, "Attendance");

  // The Faculty member reads the day, closed and never taken, with the roster as it stood.
  await redeem(page.request, origin, invitation);
  await page.goto(`/schools/${schoolId}/class-offerings/${classOfferingId}/attendance/${closed}`);
  await expect(page.getByRole("heading", { level: 1, name: courseName })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("A change now needs a Correction request.");
  await expect(rows().filter({ hasText: approved })).toContainText("Not yet");

  // They request a mark for each Student, one from the keyboard alone.
  const requestFor = async (name: string, status: string, reason: string) => {
    await page.getByRole("button", { name: `Request a correction for ${name}` }).click();
    const dialog = page.getByRole("dialog", { name: `Request a correction for ${name}?` });
    await dialog.getByLabel("Correct it to").selectOption({ label: status });
    await dialog.getByLabel("Reason").fill(reason);
    await dialog.getByRole("button", { name: "Request the correction" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Correction request" })).toHaveText(
      `Your Correction request for ${name} is pending.`,
    );
  };
  await page.getByRole("button", { name: `Request a correction for ${approved}` }).click();
  const dialog = page.getByRole("dialog", { name: `Request a correction for ${approved}?` });
  await expect(dialog).toContainText("it is made only once approved");
  await audit(page);
  await dialog.getByLabel("Correct it to").selectOption({ label: "Excused absence" });
  await page.keyboard.press("Tab");
  await expect(dialog.getByLabel("Reason")).toBeFocused();
  await page.keyboard.type("A doctor's note came in");
  // Past Cancel, to the control that goes ahead.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Request the correction" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Correction request" })).toHaveText(
    `Your Correction request for ${approved} is pending.`,
  );
  await requestFor(rejected, "Present", "Seen in the corridor");
  await requestFor(rejected, "Tardy", "Raised by mistake");
  // Nothing changes until one is approved.
  await expect(rows().filter({ hasText: approved })).toContainText("Not yet");

  // Their own requests, from the navigation, where they withdraw the mistaken one.
  await page.getByRole("link", { name: "Correction requests" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Correction requests" })).toBeVisible();
  const pending = () => recordRows(page, "Pending Correction requests");
  const decided = () => recordRows(page, "Decided Correction requests");
  await expect(pending().filter({ hasText: token })).toHaveCount(3);
  await pending().filter({ hasText: "Raised by mistake" }).getByRole("button", { name: /^Withdraw/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Withdraw" }).click();
  await expect(page.getByRole("status")).toHaveText(`${rejected}’s request is withdrawn.`);
  await expect(decided().filter({ hasText: "Raised by mistake" })).toContainText("Withdrawn");
  await expect(pending().filter({ hasText: token })).toHaveCount(2);
  // A Faculty member approves nothing.
  await expect(page.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
  await audit(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await expectNoSidewaysScroll(page);
  await audit(page);
  await darken(page);
  await expectNoSidewaysScroll(page);
  await audit(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });

  // The School Administrator's queue: they approve one and reject the other with a reason.
  await page.context().clearCookies();
  await signIn(page, seeded().schoolAdministrator);
  await expect(page).toHaveURL(/\/schools/);
  await page.goto(`/schools/${schoolId}/correction-requests`);
  await expect(pending().filter({ hasText: token })).toHaveCount(2);
  await pending().filter({ hasText: "A doctor's note came in" }).getByRole("button", { name: /^Approve/ }).click();
  const approving = page.getByRole("dialog", { name: `Approve ${approved}’s correction?` });
  await expect(approving).toContainText(`changes from Not recorded to Excused absence at once`);
  await audit(page);
  await approving.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("status")).toHaveText(`${approved}’s request is approved.`);

  await pending().filter({ hasText: "Seen in the corridor" }).getByRole("button", { name: /^Reject/ }).click();
  const rejecting = page.getByRole("dialog", { name: `Reject ${rejected}’s correction?` });
  await expect(rejecting.getByRole("button", { name: "Reject" })).toBeDisabled();
  await rejecting.getByLabel("Reason").fill("The register shows them absent");
  await rejecting.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByRole("status")).toHaveText(`${rejected}’s request is rejected.`);

  await expect(pending().filter({ hasText: token })).toHaveCount(0);
  await expect(decided().filter({ hasText: "A doctor's note came in" })).toContainText("Approved");
  await expect(decided().filter({ hasText: "Seen in the corridor" })).toContainText("The register shows them absent");
  await page.setViewportSize({ width: 360, height: 800 });
  await expectNoSidewaysScroll(page);
  await darken(page);
  await expectNoSidewaysScroll(page);
  await audit(page);

  // Approval changed the Attendance at once; the rejected request changed nothing.
  await decided().filter({ hasText: "A doctor's note came in" }).getByRole("link").click();
  await expect(page.getByRole("heading", { level: 1, name: courseName })).toBeVisible();
  await expect(rows().filter({ hasText: approved })).toContainText("Excused absence");
  await expect(rows().filter({ hasText: rejected })).toContainText("Not yet");
});
