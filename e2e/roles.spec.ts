import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { arrangePerson, changesSent, openSchool, openSection, recordRows, schoolIdOf, signIn } from "./app.ts";
import { seeded } from "./seeded.ts";
import { expect, expectNoSidewaysScroll, test } from "./test.ts";

/**
 * Roles: the School memberships sheet, where a School Administrator grants,
 * narrows and revokes a role. Each membership is its own row, so a Person
 * holding several has each managed alone.
 *
 * Whether a grant or a change is allowed is the HTTP suite's to assert. What is
 * asserted here is that the sheet offers each one, names what it does before
 * it does it, and shows what the server holds afterwards.
 */

const inForce = (page: Page) => recordRows(page, "School memberships in force");
const ended = (page: Page) => recordRows(page, "Ended School memberships");

/** A School Administrator on the Roles sheet of the first School, with a Person of this run's own. */
async function onRoles(page: Page, roles: string[] = []): Promise<string> {
  const { schoolAdministrator, schools } = seeded();
  const displayName = `Morgan ${randomUUID().slice(0, 8)}`;
  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[0]!);
  await arrangePerson(page, await schoolIdOf(page, schools[0]!), displayName, roles);
  await openSection(page, "Roles");
  await expect(page.getByRole("heading", { level: 1, name: "School memberships" })).toBeVisible();
  return displayName;
}

test("a School Administrator grants two roles to one Person, then narrows one and revokes the other", async ({
  page,
  audit,
}) => {
  const displayName = await onRoles(page);
  const grant = page.getByRole("form", { name: "Grant a School membership" });
  for (const role of ["Faculty", "Guardian"]) {
    await grant.getByLabel("Person").selectOption({ label: displayName });
    await grant.getByLabel("Role").selectOption({ label: role });
    await grant.getByRole("button", { name: "Grant membership" }).click();
    await expect(inForce(page).filter({ hasText: displayName }).filter({ hasText: role })).toHaveCount(1);
  }
  const faculty = inForce(page).filter({ hasText: displayName }).filter({ hasText: "Faculty" });
  const guardian = inForce(page).filter({ hasText: displayName }).filter({ hasText: "Guardian" });
  await expect(faculty).toContainText("No end");
  await expect(guardian).toContainText("No end");

  // Narrowed: the Faculty membership now ends, and the Guardian one is untouched.
  await page.getByRole("button", { name: `Narrow ${displayName}’s Faculty membership` }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Any other School membership");
  await dialog.getByLabel("Ends on").fill("2099-06-30");
  await audit(page);
  await dialog.getByRole("button", { name: "Set the end" }).click();
  await expect(faculty).toContainText("2099");
  await expect(guardian).toContainText("No end");

  // Revoked: the Guardian membership is ended, and the Faculty one still in force.
  await page.getByRole("button", { name: `Revoke ${displayName}’s Guardian membership` }).click();
  await expect(page.getByRole("dialog")).toContainText(`${displayName} stops holding Guardian`);
  await page.getByRole("dialog").getByRole("button", { name: "Revoke the membership" }).click();
  await expect(guardian).toHaveCount(0);
  await expect(ended(page).filter({ hasText: displayName }).filter({ hasText: "Guardian" })).toHaveCount(1);
  await expect(faculty).toContainText("2099");

  // What the sheet shows is what the server holds.
  await page.reload();
  await expect(faculty).toContainText("2099");
  await expect(inForce(page).filter({ hasText: displayName })).toHaveCount(1);
  await expect(ended(page).filter({ hasText: displayName })).toHaveCount(1);
});

test("a cancelled revocation or narrowing sends nothing and changes nothing", async ({ page }) => {
  const displayName = await onRoles(page, ["faculty"]);
  const row = inForce(page).filter({ hasText: displayName });
  await expect(row).toContainText("No end");
  const sent = changesSent(page);

  const revoke = page.getByRole("button", { name: `Revoke ${displayName}’s Faculty membership` });
  await revoke.click();
  await expect(page.getByRole("dialog")).toContainText(`${displayName} stops holding Faculty`);
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Escape is a cancellation too.
  await revoke.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("button", { name: `Narrow ${displayName}’s Faculty membership` }).click();
  await page.getByRole("dialog").getByLabel("Ends on").fill("2099-06-30");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  expect(sent).toEqual([]);
  await page.reload();
  await expect(row).toContainText("No end");
  await expect(ended(page).filter({ hasText: displayName })).toHaveCount(0);
});

test("Roles, Enrollments and Guardians are the one not-available sheet to every other role and School", async ({
  page,
}) => {
  const { schoolAdministrator, faculty, student, guardian, schools } = seeded();
  await signIn(page, schoolAdministrator);
  await expect(page.getByRole("list", { name: "Schools" })).toBeVisible();
  const first = await schoolIdOf(page, schools[0]!);
  const second = await schoolIdOf(page, schools[1]!);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/sign-in");

  for (const account of [faculty, student, guardian]) {
    await signIn(page, account);
    await expect(page.getByRole("navigation")).toBeVisible();
    const shown = async (path: string) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: "Not available" })).toBeVisible();
      return page.locator("body").innerHTML();
    };
    const noSuchPage = await shown("/no/such/page");
    // Each of them holds a role in the first School alone, so the second is
    // another School's sheets, asked for by a caller it does not hold.
    for (const schoolId of [first, second]) {
      for (const path of ["memberships", "enrollments", "guardian-links"]) {
        expect(await shown(`/schools/${schoolId}/${path}`), `${account.username} on ${path}`).toEqual(noSuchPage);
      }
    }
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL("/sign-in");
  }
});

test("with no membership to list, the sheet says so and offers the first grant", async ({ page, audit }) => {
  const { schoolAdministrator, schools } = seeded();
  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[0]!);
  // Emptied rather than arranged: a School always holds its own administrator's.
  await page.route("**/api/schools/*/memberships", (route) =>
    route.request().method() === "GET" ? route.fulfill({ status: 200, json: { memberships: [] } }) : route.fallback(),
  );
  await openSection(page, "Roles");

  await expect(page.getByRole("main")).toContainText("No School membership is in force. Grant the first one below.");
  await expect(page.getByRole("main")).toContainText("No School membership in this School has ended.");
  await expect(page.getByRole("form", { name: "Grant a School membership" })).toBeVisible();
  await audit(page);
});

/** The School date after this one, counted in UTC so no local timezone can move it. */
function dateAfter(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

// The first School keeps New York's time. Kiritimati is a day ahead of it from
// New York's 06:00 or so, and Pago Pago a day behind it until its 07:00, so
// whenever the suite runs one browser or the other is on a different date.
for (const timezoneId of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
  test.describe(`with the browser in ${timezoneId}`, () => {
    test.use({ timezoneId });

    test("the earliest end offered is the School's tomorrow, not the browser's", async ({ page }) => {
      const displayName = await onRoles(page);
      const schoolId = await schoolIdOf(page, seeded().schools[0]!);
      const answered = await page.request.get(`/api/schools/${schoolId}/school-date`);
      const { schoolDate: today } = (await answered.json()) as { schoolDate: string };
      const tomorrow = dateAfter(today);

      // Granted with an end: the School's today is refused by the field, before anything is sent.
      const grant = page.getByRole("form", { name: "Grant a School membership" });
      const endsOn = grant.getByLabel("Ends on (optional)");
      await expect(endsOn).toHaveAttribute("min", tomorrow);
      await grant.getByLabel("Person").selectOption({ label: displayName });
      await grant.getByLabel("Role").selectOption({ label: "Guardian" });
      const sent = changesSent(page);
      await endsOn.fill(today);
      await grant.getByRole("button", { name: "Grant membership" }).click();
      expect(await endsOn.evaluate((input: HTMLInputElement) => input.validity.rangeUnderflow)).toBe(true);
      expect(sent).toEqual([]);
      await endsOn.fill(tomorrow);
      await grant.getByRole("button", { name: "Grant membership" }).click();
      const guardian = inForce(page).filter({ hasText: displayName }).filter({ hasText: "Guardian" });
      await expect(guardian).not.toContainText("No end");

      // Narrowed: the same bound, and the School's tomorrow counts what it ends.
      await grant.getByLabel("Person").selectOption({ label: displayName });
      await grant.getByLabel("Role").selectOption({ label: "Faculty" });
      await grant.getByRole("button", { name: "Grant membership" }).click();
      const faculty = inForce(page).filter({ hasText: displayName }).filter({ hasText: "Faculty" });
      await expect(faculty).toContainText("No end");
      await page.getByRole("button", { name: `Narrow ${displayName}’s Faculty membership` }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByLabel("Ends on")).toHaveAttribute("min", tomorrow);
      await dialog.getByLabel("Ends on").fill(today);
      await expect(dialog.getByRole("button", { name: "Set the end" })).toBeDisabled();
      await dialog.getByLabel("Ends on").fill(tomorrow);
      await expect(dialog).toContainText("0 Teaching assignments.");
      await dialog.getByRole("button", { name: "Set the end" }).click();
      await expect(faculty).not.toContainText("No end");
    });
  });
}

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("the record stacks, and each confirmation is readable", async ({ page, audit }) => {
    const displayName = await onRoles(page, ["faculty", "guardian"]);
    await expect(inForce(page).filter({ hasText: displayName })).toHaveCount(2);
    await expectNoSidewaysScroll(page);
    await audit(page);

    await page.getByRole("button", { name: `Narrow ${displayName}’s Guardian membership` }).click();
    await expect(page.getByRole("dialog").getByRole("button", { name: "Set the end" })).toBeInViewport();
    await expectNoSidewaysScroll(page);
    await audit(page);
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  });
});
