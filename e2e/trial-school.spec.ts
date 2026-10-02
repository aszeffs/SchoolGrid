import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { acknowledgeIssuedLink, issueInvitationFor, recordRows } from "./app.ts";
import { expect, expectNoSidewaysScroll, test } from "./test.ts";

/**
 * Where scripts/smoke-test.sh serves the image with TRIALS_ENABLED on, as the
 * public showcase runs it. Every other deployment offers no trial.
 */
const SHOWCASE_ORIGIN = process.env["SCHOOLGRID_TRIALS_ORIGIN"];

const BANNER = /^Trial School · invented data · deleted in [12]h \d{1,2}m/;

/** Each role, and where it lands: the School Administrator on its People, every other role on its own account. */
const ROLES = [
  { name: "Faculty", home: "account" },
  { name: "Student", home: "account" },
  { name: "Guardian", home: "account" },
  { name: "School Administrator", home: "persons" },
] as const;

/**
 * Starts a Trial School from the front page's link, from the keyboard,
 * signing in at the stand-in provider scripts/smoke-test.sh runs as a fresh
 * visitor, and opens it. The visitor lands in it as its School Administrator.
 */
async function startTrial(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByRole("link", { name: "Continue with GitHub" }).focus();
  await page.keyboard.press("Enter");
  await approveAtProvider(page);
  return new URL(page.url()).pathname.split("/")[2]!;
}

/** Approves the sign-in at the stand-in provider's consent page, and waits to land in the new School. */
async function approveAtProvider(page: Page) {
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page).toHaveURL(/\/schools\/[^/]+\/persons$/);
}

/** Waits for the sheet to finish being read, which strikes it afresh and would close a list opened meanwhile. */
async function settled(page: Page) {
  await expect(page.getByRole("main")).not.toHaveAttribute("aria-busy", "true");
}

/** Changes role from the switcher, and waits to land on the role's home. */
async function viewAs(page: Page, name: string) {
  await settled(page);
  await page.getByRole("banner").locator("summary", { hasText: /^Viewing as / }).click();
  await page.getByRole("list", { name: "View this School as" }).getByRole("button", { name }).click();
  await expect(page.getByRole("banner").locator("summary")).toHaveText(`Viewing as ${name}`);
  await settled(page);
}

function banner(page: Page) {
  return page.getByRole("region", { name: "Trial School" });
}

test.describe("in a Trial School", () => {
  test.skip(SHOWCASE_ORIGIN === undefined || SHOWCASE_ORIGIN === "", "only the smoke test serves trials");
  test.use({ baseURL: SHOWCASE_ORIGIN });

  test("the landing page says plainly when the site is too busy to start a trial", async ({ page }) => {
    // The live cap, reached: arranged by arriving where the server sends a
    // visitor back to then, rather than by filling the showcase with thirty trials.
    await page.goto("/?trial=busy");

    await expect(page.getByRole("alert")).toHaveText("SchoolGrid is busy right now. Try again in a little while.");
    // Said once: the address no longer says it.
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("link", { name: "Continue with GitHub" })).toBeVisible();
  });

  test("a visitor who cancels at the provider is back on the front page, told so, with no trial", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Continue with GitHub" }).click();

    await page.getByRole("button", { name: "Cancel" }).click();

    await expect(page).toHaveURL("/");
    await expect(page.getByRole("alert")).toHaveText("Sign-in was cancelled, so no trial was started.");
    expect(await (await page.request.get("/api/session")).json()).toEqual({ status: "refused" });
  });

  test("views the School as each role from the keyboard, landing on each role's home", async ({ page }) => {
    const schoolId = await startTrial(page);
    await expect(banner(page)).toContainText(BANNER);
    // A visitor's trial is theirs until it ends: the strip offers no other.
    await expect(banner(page).getByRole("button")).toHaveCount(0);

    for (const { name, home } of ROLES) {
      await settled(page);
      const switcher = page.getByRole("banner").locator("summary", { hasText: /^Viewing as / });
      await switcher.focus();
      await page.keyboard.press("Enter");
      const choice = page.getByRole("list", { name: "View this School as" }).getByRole("button", { name });
      await choice.focus();
      await page.keyboard.press("Enter");

      await expect(page).toHaveURL(new RegExp(`/schools/${schoolId}/${home}$`));
      await expect(page.getByRole("banner").locator("summary")).toHaveText(`Viewing as ${name}`);
      await expect(page.getByRole("list", { name: /^Your roles in / })).toHaveText(name);
      await expect(banner(page)).toContainText(BANNER);
    }
  });

  test("finds Attendance already there in every role, and a request waiting for the School Administrator", async ({ page }) => {
    const schoolId = await startTrial(page);
    const { correctionRequests } = (await (await page.request.get(`/api/schools/${schoolId}/correction-requests`)).json()) as {
      correctionRequests: {
        kind: string;
        classOffering: { label: string; course: { name: string }; term: { name: string } };
      }[];
    };
    const attendanceRequest = correctionRequests.find((request) => request.kind === "attendance");
    // A Term's first day has no day behind it to have been taken.
    test.skip(attendanceRequest === undefined, "the trial started on its Term's first day");
    const { classOffering } = attendanceRequest!;
    const offeringName = `${classOffering.course.name}, ${classOffering.label}`;
    // Class Offering or Student, then Present, Tardy, Excused absence, Unexcused absence, Absent pending review, and Not recorded.
    const pendingReview = (row: ReturnType<typeof recordRows>) => row.getByRole("cell").nth(5);
    const pending = () => recordRows(page, "Pending Correction requests").filter({ hasText: "Avery Castellano" });

    await settled(page);
    await page.getByRole("link", { name: "Correction requests" }).first().click();
    await expect(pending()).toContainText("Sam Achterberg");
    await expect(pending().getByRole("button", { name: /^Approve/ })).toBeVisible();
    // Its request opens the session it names.
    await pending().getByRole("link").first().click();
    await expect(page.getByRole("heading", { level: 1, name: offeringName })).toBeVisible();
    await expect(page.getByRole("main")).toContainText("Avery Castellano");

    await viewAs(page, "Faculty");
    await page.getByRole("link", { name: "Correction requests" }).first().click();
    // Their own, which they may withdraw and not approve.
    await expect(pending().getByRole("button", { name: /^Withdraw/ })).toBeVisible();
    await pending().getByRole("link").first().click();
    await expect(page.getByRole("heading", { level: 1, name: offeringName })).toBeVisible();
    await expect(page.getByRole("main")).toContainText("Avery Castellano");
    await page.getByRole("link", { name: offeringName }).first().click();
    const totals = recordRows(page, "Attendance totals");
    await expect(pendingReview(totals.filter({ hasText: "Jamie Lindqvist" }))).toHaveText("1");

    await viewAs(page, "Student");
    await page.getByRole("link", { name: "Your attendance" }).click();
    const own = new RegExp(`^Jamie Lindqvist's Attendance totals in ${classOffering.term.name}, `);
    const ownRow = page.getByRole("table", { name: own }).getByRole("row").filter({ hasText: offeringName });
    await expect(pendingReview(ownRow)).toHaveText("1");

    await viewAs(page, "Guardian");
    await expect(page.getByRole("heading", { level: 2, name: "Attendance", exact: true })).toBeVisible();
    const linkedRow = page.getByRole("table", { name: own }).getByRole("row").filter({ hasText: offeringName });
    await expect(pendingReview(linkedRow)).toHaveText("1");
  });

  test("once the trial expires, says it was deleted and starts a new one", async ({ page }) => {
    await page.clock.install();
    await startTrial(page);

    await page.clock.fastForward("02:00:00");
    await expect(page).toHaveURL(/\/trial-ended$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your trial School has been deleted");

    // Back to the time the server keeps, which the new trial's two hours are counted from.
    await page.clock.setSystemTime(Date.now());
    await page.getByRole("link", { name: "Continue with GitHub" }).click();
    await approveAtProvider(page);
    await expect(banner(page)).toContainText(BANNER);
  });

  test("a visitor who leaves and signs in again is back in the same School", async ({ page, browser }) => {
    const subject = randomUUID();
    await page.goto("/");
    await page.getByRole("link", { name: "Continue with GitHub" }).click();
    await page.getByLabel("Subject").fill(subject);
    await approveAtProvider(page);
    const schoolUrl = page.url();
    await page.close();

    // Another browser, holding no Session: only the sign-in says who this is.
    const returning = await browser.newPage({ baseURL: SHOWCASE_ORIGIN! });
    await returning.goto("/");
    await returning.getByRole("link", { name: "Continue with GitHub" }).click();
    await returning.getByLabel("Subject").fill(subject);
    await approveAtProvider(returning);

    await expect(returning).toHaveURL(schoolUrl);
    await expect(banner(returning)).toContainText(BANNER);
    await returning.close();
  });

  test("issues an Invitation whose redeemed account sees the trial but views it as no other role", async ({
    page,
    browser,
  }) => {
    await startTrial(page);
    await issueInvitationFor(page, "Priya Okonkwo");
    const link = await page.getByLabel("Invitation link").inputValue();
    await acknowledgeIssuedLink(page);

    const invitee = await browser.newPage({ baseURL: SHOWCASE_ORIGIN! });
    await invitee.goto(link);
    await invitee.getByLabel("Username").fill(`priya-${Date.now()}`);
    await invitee.getByLabel("Password").fill("correct horse battery staple");
    await invitee.getByRole("button", { name: "Redeem Invitation" }).click();

    await expect(invitee).toHaveURL(/\/schools\/[^/]+\/account$/);
    await expect(banner(invitee)).toContainText(BANNER);
    await expect(invitee.getByRole("banner").locator("summary", { hasText: /^Viewing as / })).toHaveCount(0);
    await invitee.close();
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`holds a 360px phone in the ${colorScheme} theme, on the front page and with the roles open`, async ({ page, audit }) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width: 360, height: 800 });
      await page.goto("/");
      await expect(page.getByRole("link", { name: "Continue with GitHub" })).toBeVisible();
      await expectNoSidewaysScroll(page);
      await audit(page);

      await startTrial(page);
      await settled(page);

      await page.getByRole("banner").locator("summary", { hasText: /^Viewing as / }).click();
      await expect(page.getByRole("list", { name: "View this School as" })).toBeVisible();
      await expectNoSidewaysScroll(page);
      await audit(page);

      await page.goto("/trial-ended");
      await expectNoSidewaysScroll(page);
      await audit(page);
    });
  }
});
