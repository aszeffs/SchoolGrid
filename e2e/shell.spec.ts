import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { addPerson, openSchool, personsRecord, schoolsList, signIn } from "./app.ts";
import { seeded } from "./seeded.ts";
import { expect, test } from "./test.ts";

/** Every page within a School, as the navigation names it, and where it is. */
const SECTIONS = [
  { label: "Your account", path: "account", heading: "Your account" },
  { label: "People", path: "persons", heading: "Persons" },
  { label: "Invitations", path: "invitations", heading: "Invitations" },
  { label: "Roles", path: "memberships", heading: "School memberships" },
  { label: "Enrollments", path: "enrollments", heading: "Enrollments" },
  { label: "Guardians", path: "guardian-links", heading: "Guardian links" },
  { label: "Audit", path: "audit-records", heading: "Audit" },
  { label: "Settings", path: "settings", heading: "School settings" },
];

function navLinks(page: Page) {
  return page.getByRole("navigation").getByRole("link");
}

/** The ids of the seeded Schools, in the order `seeded().schools` names them, as the administrator reaches them. */
async function schoolIds(page: Page): Promise<string[]> {
  const { schools } = (await (await page.request.get("/api/session")).json()) as {
    schools: { schoolId: string; name: string }[];
  };
  return seeded().schools.map((name) => schools.find((school) => school.name === name)!.schoolId);
}

/**
 * Records the navigation's links each time the page changes, from before the
 * app's own script runs, so a navigation that was drawn wrong and then
 * corrected is caught even though it never survives to be asserted on.
 */
async function recordEveryNavigation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[][] = [];
    (window as unknown as { navigationsSeen: string[][] }).navigationsSeen = seen;
    new MutationObserver(() => {
      const nav = document.querySelector("nav");
      if (nav !== null) {
        seen.push([...nav.querySelectorAll("a")].map((link) => link.textContent ?? ""));
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

/** The one School the signed-in account reaches. */
async function ownSchool(page: Page): Promise<string> {
  const { schools } = (await (await page.request.get("/api/session")).json()) as { schools: { schoolId: string }[] };
  return schools[0]!.schoolId;
}

async function navigationsSeen(page: Page): Promise<string[][]> {
  return page.evaluate(() => (window as unknown as { navigationsSeen: string[][] }).navigationsSeen);
}

test("inside a School the header names the Person and the School, and the switcher moves between Schools", async ({
  page,
  audit,
}) => {
  const { schoolAdministrator, schools } = seeded();
  const displayName = `Avery ${randomUUID().slice(0, 8)}`;

  // Reaching two Schools, the account is asked which.
  await signIn(page, schoolAdministrator);
  await expect(page).toHaveURL("/");
  await expect(schoolsList(page)).toHaveText(schools, { useInnerText: true });
  await openSchool(page, schools[0]!);

  const header = page.getByRole("banner");
  await expect(header.getByText(schools[0]!, { exact: true })).toBeVisible();
  await expect(header.getByText(`Signed in as ${schoolAdministrator.displayName}`)).toBeVisible();
  await expect(navLinks(page)).toHaveText(SECTIONS.map(({ label }) => label));
  await expect(navLinks(page).filter({ hasText: "People" })).toHaveAttribute("aria-current", "page");
  await addPerson(page, displayName);
  await expect(personsRecord(page).filter({ hasText: displayName })).toHaveCount(1);

  // The switcher is held open for the audit, which should see its links too.
  await header.getByText("Switch School").click();
  await audit(page);
  await header.getByRole("list", { name: "Your other Schools" }).getByRole("link", { name: schools[1]! }).click();

  const [, second] = await schoolIds(page);
  await expect(page).toHaveURL(`/schools/${second}/persons`);
  await expect(header.getByText(schools[1]!, { exact: true })).toBeVisible();
  // Named now only among the Schools the closed switcher would offer.
  await expect(header.getByText(schools[0]!, { exact: true })).toBeHidden();
  await expect(page.getByRole("heading", { level: 1, name: "Persons" })).toBeVisible();
  // Nothing from the first School is shown under the second (ADR-0001).
  await expect(personsRecord(page).filter({ hasText: displayName })).toHaveCount(0);
});

test("an account reaching one School goes straight into it, and sees only what its roles reach", async ({
  page,
}) => {
  const { faculty, schools } = seeded();
  await recordEveryNavigation(page);

  await signIn(page, faculty);
  // Not a School Administrator, so the School opens on their own account.
  await expect(page).toHaveURL(/\/schools\/[^/]+\/account$/);
  const header = page.getByRole("banner");
  await expect(header.getByText(schools[0]!, { exact: true })).toBeVisible();
  await expect(header.getByText(`Signed in as ${faculty.displayName}`)).toBeVisible();
  await expect(navLinks(page)).toHaveText(["Your account", "People"]);
  // With nowhere else to go, no switcher is offered.
  await expect(header.getByText("Switch School")).toHaveCount(0);

  // The navigation was never drawn with anything the Faculty member does not reach.
  const seen = await navigationsSeen(page);
  expect(seen.length).toBeGreaterThan(0);
  for (const links of seen) {
    expect(links).toEqual(["Your account", "People"]);
  }

  // Asked for by its URL, a page their roles do not reach still asks for its
  // records: they are the server's to refuse, not the navigation's (ADR-0007).
  const schoolId = new URL(page.url()).pathname.split("/")[2]!;
  const asked = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/schools/${schoolId}/audit-records`);
  await page.goto(`/schools/${schoolId}/audit-records`);
  expect((await asked).ok()).toBe(false);
  await expect(page.getByRole("heading", { level: 1, name: "Not available" })).toBeVisible();
});

test("every page within a School opens from its URL", async ({ page, audit }) => {
  await signIn(page, seeded().schoolAdministrator);
  await expect(schoolsList(page)).not.toHaveCount(0);
  const [first] = await schoolIds(page);

  for (const { label, path, heading } of SECTIONS) {
    await page.goto(`/schools/${first}/${path}`);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(navLinks(page).filter({ hasText: label })).toHaveAttribute("aria-current", "page");
    await audit(page);
  }
});

test("every way a page is not available looks the same", async ({ page }) => {
  // The administrator reaches the second School; the Faculty member does not.
  await signIn(page, seeded().schoolAdministrator);
  await expect(schoolsList(page)).not.toHaveCount(0);
  const [, unreached] = await schoolIds(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/sign-in");

  await signIn(page, seeded().faculty);
  await expect(page.getByRole("navigation")).toBeVisible();

  const shown = async (path: string) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Not available" })).toBeVisible();
    return { title: await page.title(), body: await page.locator("body").innerHTML() };
  };
  const unreachedSchool = await shown(`/schools/${unreached}/persons`);
  const noSuchSchool = await shown(`/schools/${randomUUID()}/persons`);
  const noSuchPage = await shown("/no/such/page");
  // A School the account reaches, whose page the API then refuses.
  await page.route("**/api/schools/*/persons", (route) => route.fulfill({ status: 404, json: { status: "refused" } }));
  const refused = await shown(`/schools/${await ownSchool(page)}/persons`);

  expect(unreachedSchool).toEqual(noSuchPage);
  expect(noSuchSchool).toEqual(noSuchPage);
  expect(refused).toEqual(noSuchPage);
});

test("a session that has ended sends the next step to sign in", async ({ page, context }) => {
  const { schoolAdministrator, schools } = seeded();
  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[0]!);
  await expect(personsRecord(page).first()).toBeVisible();

  // Ended elsewhere: the page still holds what it drew, but the server holds no session.
  await context.clearCookies();
  await navLinks(page).filter({ hasText: "Roles" }).click();
  await expect(page).toHaveURL("/sign-in");
});

test("sign-out works from a page within a School", async ({ page }) => {
  const { schoolAdministrator, schools } = seeded();
  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[0]!);
  await navLinks(page).filter({ hasText: "Audit" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Audit" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/sign-in");
  await page.goBack();
  await expect(page).toHaveURL("/sign-in");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("the navigation is reachable and nothing scrolls sideways", async ({ page, audit }) => {
    const { schoolAdministrator, schools } = seeded();
    await signIn(page, schoolAdministrator);
    await openSchool(page, schools[0]!);
    await expect(page.getByRole("heading", { level: 1, name: "Persons" })).toBeVisible();

    for (const link of await navLinks(page).all()) {
      await expect(link).toBeInViewport();
    }
    await page.getByRole("banner").getByText("Switch School").click();
    await expect(page.getByRole("list", { name: "Your other Schools" })).toBeInViewport();

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await audit(page);
  });
});

test("the shell is reached from the keyboard, with focus shown", async ({ page }) => {
  await signIn(page, seeded().schoolAdministrator);
  await expect(schoolsList(page)).not.toHaveCount(0);
  const [first] = await schoolIds(page);
  // Loaded afresh, so the first Tab starts from the top of the page.
  await page.goto(`/schools/${first}/persons`);
  await expect(page.getByRole("heading", { level: 1, name: "Persons" })).toBeVisible();

  const focused = () =>
    page.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      return { text: element.textContent ?? "", outline: getComputedStyle(element).outlineStyle };
    });

  // Tabbed through in order: the switcher, sign-out, then each page of the School.
  const expected = ["Switch School", "Sign out", ...SECTIONS.map(({ label }) => label)];
  const reached: string[] = [];
  for (const _ of expected) {
    await page.keyboard.press("Tab");
    const { text, outline } = await focused();
    reached.push(text);
    expect(outline, `focus on ${text} is shown`).not.toBe("none");
  }
  expect(reached).toEqual(expected);

  // And followed from it, to the last page it reached.
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: SECTIONS.at(-1)!.heading })).toBeVisible();
});
