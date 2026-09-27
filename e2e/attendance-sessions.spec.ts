import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { arrange, arrangePerson, darken, openSchool, recordRows, schoolIdOf, signIn } from "./app.ts";
import { seeded } from "./seeded.ts";
import { expect, expectNoSidewaysScroll, test } from "./test.ts";

/**
 * Attendance sessions: a Faculty member taking a class's attendance with Mark
 * all Present and one exception, a co-teacher's change shown in place rather
 * than overwritten, and the session read-only for a School Administrator;
 * then the marks by date and each Student's totals on the class's page.
 * Which marks and dates are refused, and what is audited, is the HTTP suite's
 * to assert; this is about the page doing it and saying what it did.
 *
 * Arranged in the third seeded School, the Attendance specs' own, in a year
 * around today with every day of the week an Instructional day, so today can
 * be taken whatever day the suite runs.
 */

const EVERY_DAY = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function yearAroundToday(): { firstDate: string; lastDate: string } {
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  return { firstDate: day(-30), lastDate: day(30) };
}

/** Issues an Invitation to a Person of the spec's own, and returns what redeeming it sends. */
async function invitationFor(page: Page, schoolId: string, personId: string, username: string) {
  const { link } = await arrange<{ link: string }>(page, schoolId, "/invitations", { personId });
  return { secret: new URL(link).hash.slice(1), username, password: "a Faculty member's own staple, long enough" };
}

/** Redeems an Invitation through this client, which is left signed in as the new account. */
async function redeem(client: APIRequestContext, origin: string, redemption: Record<string, string>) {
  const redeemed = await client.post("/api/invitations/redeem", { headers: { origin }, data: redemption });
  expect(redeemed.status()).toBe(201);
}

test("a Faculty member takes a class's attendance with Mark all Present and one exception, and sees a co-teacher's change in place", async ({
  page,
  audit,
  playwright,
}) => {
  const { schoolAdministrator, schools } = seeded();
  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[2]!);
  const schoolId = await schoolIdOf(page, schools[2]!);
  const origin = new URL(page.url()).origin;
  const token = randomUUID().slice(0, 8);
  const dates = yearAroundToday();
  const { academicYear } = await arrange<{ academicYear: { id: string } }>(page, schoolId, "/academic-years", {
    name: `Year ${token}`,
    ...dates,
    weekdays: EVERY_DAY,
  });
  const divided = await page.request.patch(`/api/schools/${schoolId}/academic-years/${academicYear.id}`, {
    headers: { origin },
    data: { terms: [{ name: "Whole year", ...dates }] },
  });
  expect(divided.ok()).toBe(true);
  const { academicYear: year } = (await divided.json()) as { academicYear: { terms: { id: string }[] } };
  const courseName = `Algebra ${token}`;
  const { course } = await arrange<{ course: { id: string } }>(page, schoolId, "/courses", { name: courseName });
  const { classOffering } = await arrange<{ classOffering: { id: string } }>(page, schoolId, "/class-offerings", {
    courseId: course.id,
    termId: year.terms[0]!.id,
  });
  const present = `Parker ${token}`;
  const absent = `Quinn ${token}`;
  const studentIds: string[] = [];
  for (const name of [present, absent]) {
    const personId = await arrangePerson(page, schoolId, name, ["student"]);
    await arrange(page, schoolId, "/enrollments", { studentPersonId: personId });
    studentIds.push(personId);
  }
  await arrange(page, schoolId, `/class-offerings/${classOffering.id}/roster-memberships`, { personIds: studentIds });
  const teacher = `Teagan ${token}`;
  const coTeacher = `Corey ${token}`;
  const teacherId = await arrangePerson(page, schoolId, teacher, ["faculty"]);
  const coTeacherId = await arrangePerson(page, schoolId, coTeacher, ["faculty"]);
  for (const personId of [teacherId, coTeacherId]) {
    await arrange(page, schoolId, `/class-offerings/${classOffering.id}/teaching-assignments`, { personId });
  }
  const teacherInvitation = await invitationFor(page, schoolId, teacherId, `teagan-${token}`);
  const coTeacherInvitation = await invitationFor(page, schoolId, coTeacherId, `corey-${token}`);
  const session = `/schools/${schoolId}/class-offerings/${classOffering.id}/attendance`;
  const rows = () => recordRows(page, "Attendance");
  const status = (name: string) => page.getByLabel(`${name}’s status`);

  // The School Administrator reads the session, and is told why they cannot record it.
  await page.goto(session);
  await expect(page.getByRole("heading", { level: 1, name: courseName })).toBeVisible();
  await expect(page.getByRole("main")).toContainText(
    "School Administrators read Attendance here. A change of theirs goes through a Correction request.",
  );
  await expect(page.getByRole("main")).toContainText("Nobody has opened this session.");
  await audit(page);

  // The co-teacher signs in apart, as a browser of their own would.
  const coTeacherBrowser = await playwright.request.newContext({ baseURL: origin });
  await redeem(coTeacherBrowser, origin, coTeacherInvitation);
  // The Faculty member opens today's session from the class's page.
  await redeem(page.request, origin, teacherInvitation);
  await page.goto(`/schools/${schoolId}/class-offerings/${classOffering.id}`);
  await page.getByRole("link", { name: "Today’s Attendance session" }).click();
  await expect(rows()).toHaveCount(3);
  await expect(status(present)).toHaveValue("");
  await expect(status(absent)).toHaveValue("");
  await expect(page.getByRole("main")).toContainText(`By ${teacher}`);
  await audit(page);

  await page.getByRole("button", { name: "Mark all Present" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toHaveText(
    "Saved, and every unmarked Student is marked Present.",
  );
  await expect(status(present)).toHaveValue("present");
  await expect(status(absent)).toHaveValue("present");

  // One exception, saved from the keyboard.
  await status(absent).selectOption({ label: "Unexcused absence" });
  await page.getByRole("button", { name: "Save" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toHaveText("Saved.");
  await expect(rows().filter({ hasText: absent })).toContainText(teacher);

  // The co-teacher changes a mark after this page read it.
  const read = await coTeacherBrowser.get(`/api/schools/${schoolId}/class-offerings/${classOffering.id}/attendance-session`);
  const { attendanceSession } = (await read.json()) as { attendanceSession: { date: string } };
  const changed = await coTeacherBrowser.patch(
    `/api/schools/${schoolId}/class-offerings/${classOffering.id}/attendance-session`,
    {
      headers: { origin },
      data: {
        date: attendanceSession.date,
        marks: [{ studentPersonId: studentIds[0], loaded: "present", status: "tardy" }],
      },
    },
  );
  expect(changed.ok()).toBe(true);
  await coTeacherBrowser.dispose();

  // Changing it here too is refused, and the newer value shown in its place.
  await status(present).selectOption({ label: "Excused absence" });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toHaveText(
    "Saved. One mark was not saved: see beside it.",
  );
  await expect(rows().filter({ hasText: present })).toContainText(
    `${coTeacher} marked this Tardy at`,
  );
  await expect(status(present)).toHaveValue("tardy");
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
  await expect(status(present)).toHaveValue("tardy");
  await expect(status(absent)).toHaveValue("unexcused_absence");

  // The class's page shows the marks by date and each Student's totals, at a phone's width in the dark.
  await page.getByRole("link", { name: courseName }).click();
  const totals = recordRows(page, "Attendance totals");
  // Student, then Present, Tardy, Excused absence, Unexcused absence, Absent pending review, and Not recorded.
  const counted = /^\d+$/;
  await expect(totals.filter({ hasText: present }).getByRole("cell")).toHaveText([present, "0", "1", "0", "0", "0", counted]);
  await expect(totals.filter({ hasText: absent }).getByRole("cell")).toHaveText([absent, "0", "0", "0", "1", "0", counted]);
  const grid = page.getByRole("region", { name: "By date" });
  await expect(grid.getByRole("row", { name: new RegExp(present) })).toContainText("Tardy");
  await expectNoSidewaysScroll(page);
  await audit(page);

  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await expectNoSidewaysScroll(page);
  await audit(page);

  // And wide, in the light, where the grid scrolls from the keyboard and a date opens its session.
  await page.setViewportSize({ width: 1280, height: 800 });
  await grid.focus();
  await expect(grid).toBeFocused();
  await audit(page);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/attendance/${dates.firstDate}$`));
  await expect(page.getByRole("heading", { level: 1, name: courseName })).toBeVisible();
});
