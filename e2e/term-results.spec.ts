import { arrange, arrangePerson, darken, invitationFor, recordRows, redeem, withAttendanceOffering } from "./app.ts";
import { expect, expectNoSidewaysScroll, test } from "./test.ts";

/**
 * Draft Term results: a Faculty member recording a class's drafts, a
 * co-teacher's change shown in place rather than overwritten, and the drafts
 * read-only for a School Administrator. Which drafts are refused, and what is
 * audited, is the HTTP suite's to assert; this is about the page doing it and
 * saying what it did.
 *
 * Arranged in the Attendance specs' own School: see withAttendanceOffering.
 */

test("a Faculty member records a class's draft Term results, and sees a co-teacher's change in place", async ({
  page,
  audit,
  playwright,
}) => {
  const { schoolId, classOfferingId, courseName, token } = await withAttendanceOffering(page);
  const origin = new URL(page.url()).origin;
  const first = `Parker ${token}`;
  const second = `Quinn ${token}`;
  const studentIds: string[] = [];
  for (const name of [first, second]) {
    const personId = await arrangePerson(page, schoolId, name, ["student"]);
    await arrange(page, schoolId, "/enrollments", { studentPersonId: personId });
    studentIds.push(personId);
  }
  await arrange(page, schoolId, `/class-offerings/${classOfferingId}/roster-memberships`, { personIds: studentIds });
  const teacher = `Teagan ${token}`;
  const coTeacher = `Corey ${token}`;
  const teacherId = await arrangePerson(page, schoolId, teacher, ["faculty"]);
  const coTeacherId = await arrangePerson(page, schoolId, coTeacher, ["faculty"]);
  for (const personId of [teacherId, coTeacherId]) {
    await arrange(page, schoolId, `/class-offerings/${classOfferingId}/teaching-assignments`, { personId });
  }
  const teacherInvitation = await invitationFor(page, schoolId, teacherId, `teagan-${token}`);
  const coTeacherInvitation = await invitationFor(page, schoolId, coTeacherId, `corey-${token}`);
  const results = `/schools/${schoolId}/class-offerings/${classOfferingId}/term-results`;
  const rows = () => recordRows(page, "Term results");
  const value = (name: string) => page.getByLabel(`${name}’s value`);
  const score = (name: string) => page.getByLabel(`${name}’s score, 0 to 100`);
  const comment = (name: string) => page.getByLabel(`${name}’s comment`);
  const saved = () => page.getByRole("status").filter({ hasText: "Saved" });

  // The School Administrator reads the drafts, and is told why they cannot record them.
  await page.goto(results);
  await expect(page.getByRole("heading", { level: 1, name: courseName })).toBeVisible();
  await expect(page.getByRole("main")).toContainText(
    "School Administrators read draft Term results here. The Faculty teaching this class record them.",
  );
  await expect(value(first)).toHaveCount(0);
  await audit(page);

  // The co-teacher signs in apart, as a browser of their own would.
  const coTeacherBrowser = await playwright.request.newContext({ baseURL: origin });
  await redeem(coTeacherBrowser, origin, coTeacherInvitation);
  // The Faculty member opens the class's Term results from its page.
  await redeem(page.request, origin, teacherInvitation);
  await page.goto(`/schools/${schoolId}/class-offerings/${classOfferingId}`);
  await page.getByRole("link", { name: /^Term results for / }).click();
  // The head, then each Student.
  await expect(rows()).toHaveCount(3);
  await expect(value(first)).toHaveValue("");
  await audit(page);

  // One Student gets a value, score and comment; the other is left without a value. Saved from the keyboard.
  await value(first).selectOption("B");
  await score(first).fill("84.5");
  await comment(first).fill("Careful work, with room to push further.");
  await page.getByRole("button", { name: "Save" }).focus();
  await page.keyboard.press("Enter");
  await expect(saved()).toHaveText("Saved.");
  await expect(rows().filter({ hasText: first })).toContainText(teacher);
  await expect(value(second)).toHaveValue("");

  // The co-teacher changes that draft after this page read it.
  const path = `/api/schools/${schoolId}/class-offerings/${classOfferingId}/term-results`;
  const changed = await coTeacherBrowser.patch(path, {
    headers: { origin },
    data: {
      drafts: [
        {
          studentPersonId: studentIds[0],
          loaded: { value: "B", score: 84.5, comment: "Careful work, with room to push further." },
          value: "A",
          score: 91,
          comment: "Careful work, with room to push further.",
        },
      ],
    },
  });
  expect(changed.ok()).toBe(true);
  await coTeacherBrowser.dispose();

  // Changing it here too is refused, and the newer content shown in its place, while the other Student's saves.
  await value(first).selectOption("C");
  await value(second).selectOption("D");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(saved()).toHaveText("Saved. One result was not saved: see beside it.");
  await expect(rows().filter({ hasText: first })).toContainText(`${coTeacher} changed this result at`);
  await expect(rows().filter({ hasText: first })).toContainText("A, score 91");
  await expect(value(first)).toHaveValue("A");
  await expect(score(first)).toHaveValue("91");
  await expect(value(second)).toHaveValue("D");
  await audit(page);

  // It holds a phone's width, in both renditions.
  await page.setViewportSize({ width: 360, height: 800 });
  await expectNoSidewaysScroll(page);
  await audit(page);
  await darken(page);
  await expectNoSidewaysScroll(page);
  await audit(page);

  // What the page shows is what the server holds, and it opens from its URL.
  await page.reload();
  await expect(value(first)).toHaveValue("A");
  await expect(value(second)).toHaveValue("D");
});
