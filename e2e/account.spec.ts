import type { Page } from "@playwright/test";
import { openSchool, signIn } from "./app.ts";
import { seeded } from "./seeded.ts";
import { expect, expectNoSidewaysScroll, test } from "./test.ts";

/**
 * Your account: where a Faculty member, a Student and a Guardian land, and
 * what each of them is told there.
 *
 * Each role is signed in as and asserted on in turn, because what the page
 * holds differs by role and the point of the page is that it holds what that
 * role actually has.
 */

/** What the sheet says about this Person, by the term struck beside it. */
async function factsOn(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll("main dl.facts")].flatMap((list) => {
        const terms = [...list.querySelectorAll("dt")];
        return terms.map((term, index) => [
          term.textContent ?? "",
          list.querySelectorAll("dd")[index]?.textContent ?? "",
        ]);
      }),
    ),
  );
}

function linkedStudents(page: Page) {
  return page.getByRole("table", { name: "Students you are linked to" }).getByRole("row");
}

/** Every role that lands here is told what is not built, in the glossary's own terms. */
async function expectSaysWhatIsNotBuilt(page: Page): Promise<void> {
  const notBuilt = page.getByRole("main").getByText(/not built yet/);
  await expect(notBuilt.first()).toBeVisible();
  await expect(page.getByRole("main")).toContainText("Attendance");
  await expect(page.getByRole("main")).toContainText("Term results");
}

test("a Student lands on their account, which names their School, their role and their Enrollment", async ({
  page,
  audit,
}) => {
  const { student, schools } = seeded();
  await signIn(page, student);

  await expect(page).toHaveURL(/\/schools\/[^/]+\/account$/);
  await expect(page.getByRole("heading", { level: 1, name: "Your account" })).toBeVisible();
  expect(await factsOn(page)).toMatchObject({
    Person: student.displayName,
    School: schools[0]!,
    "School memberships": "Student",
  });

  // Enrolled by the setup, so the Enrollment is open and says so.
  await expect(page.getByRole("heading", { name: "Your Enrollment" })).toBeVisible();
  expect(await factsOn(page)).toMatchObject({ Ended: "Open" });
  // A Student is linked to nobody, so that record is not on their sheet at all.
  await expect(page.getByRole("heading", { name: "Students you are linked to" })).toHaveCount(0);
  await expectSaysWhatIsNotBuilt(page);
  await audit(page);
});

test("a Guardian sees each Student they are linked to, and what that link lets them read", async ({
  page,
  audit,
}) => {
  const { guardian, student } = seeded();
  await signIn(page, guardian);

  await expect(page).toHaveURL(/\/schools\/[^/]+\/account$/);
  // The URL is set before the sheet has been printed, so the record is read
  // only once the sheet names itself.
  await expect(page.getByRole("heading", { level: 1, name: "Your account" })).toBeVisible();
  expect(await factsOn(page)).toMatchObject({
    Person: guardian.displayName,
    "School memberships": "Guardian",
  });

  // The link's Access profile as the setup set it: Attendance yes, results no.
  // Read as written rather than as printed, since the mark is struck in caps.
  await expect(
    linkedStudents(page).filter({ hasText: student.displayName }).getByRole("cell"),
  ).toHaveText([student.displayName, "May read", "May not read"]);
  // Read-only here: changing a profile is a School Administrator's.
  await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
  // Holding no Student membership, they are told nothing about an Enrollment.
  await expect(page.getByRole("heading", { name: "Your Enrollment" })).toHaveCount(0);
  await expectSaysWhatIsNotBuilt(page);
  await audit(page);
});

test("a Faculty member holding several roles sees all of them on the one page", async ({ page, audit }) => {
  const { faculty, student } = seeded();
  await signIn(page, faculty);

  await expect(page).toHaveURL(/\/schools\/[^/]+\/account$/);
  await expect(page.getByRole("heading", { level: 1, name: "Your account" })).toBeVisible();
  expect(await factsOn(page)).toMatchObject({
    Person: faculty.displayName,
    "School memberships": "Faculty, Guardian",
  });
  // What the second role holds is on the same sheet as the first.
  await expect(linkedStudents(page).filter({ hasText: student.displayName })).toHaveCount(1);
  await expectSaysWhatIsNotBuilt(page);
  await audit(page);
});

test("a School Administrator is not sent here, and their landing page is the School's People", async ({
  page,
}) => {
  const { schoolAdministrator, schools } = seeded();
  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[0]!);

  await expect(page).toHaveURL(/\/schools\/[^/]+\/persons$/);
  await expect(page.getByRole("heading", { level: 1, name: "Persons" })).toBeVisible();
});

test("anything the actor may not read is the one not-available sheet", async ({ page }) => {
  await signIn(page, seeded().student);
  await expect(page.getByRole("heading", { level: 1, name: "Your account" })).toBeVisible();
  const schoolId = new URL(page.url()).pathname.split("/")[2]!;

  await page.route("**/api/schools/*/account", (route) =>
    route.fulfill({ status: 404, json: { status: "refused" } }),
  );
  await page.goto(`/schools/${schoolId}/account`);
  await expect(page.getByRole("heading", { name: "Not available" })).toBeVisible();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("the Guardian's record is read down rather than scrolled across", async ({ page, audit }) => {
    const { guardian, student } = seeded();
    await signIn(page, guardian);

    await expect(linkedStudents(page).filter({ hasText: student.displayName })).toHaveCount(1);
    await expectNoSidewaysScroll(page);
    await audit(page);
  });
});
