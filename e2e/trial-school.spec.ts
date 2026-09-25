import type { Page } from "@playwright/test";
import { acknowledgeIssuedLink, issueInvitationFor } from "./app.ts";
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
 * Starts a Trial School from the front page's button, from the keyboard, and
 * opens it. The visitor lands in it as its School Administrator.
 */
async function startTrial(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: "Start a trial" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/schools\/[^/]+\/persons$/);
  return new URL(page.url()).pathname.split("/")[2]!;
}

/** Waits for the sheet to finish being read, which strikes it afresh and would close a list opened meanwhile. */
async function settled(page: Page) {
  await expect(page.getByRole("main")).not.toHaveAttribute("aria-busy", "true");
}

function banner(page: Page) {
  return page.getByRole("region", { name: "Trial School" });
}

test.describe("in a Trial School", () => {
  test.skip(SHOWCASE_ORIGIN === undefined || SHOWCASE_ORIGIN === "", "only the smoke test serves trials");
  test.use({ baseURL: SHOWCASE_ORIGIN });

  test("the landing page says plainly when the site is too busy to start a trial", async ({ page }) => {
    // The live cap, reached: arranged by answering as the server does rather
    // than by filling the showcase with thirty trials.
    await page.route("/api/trials", (route) =>
      route.request().method() === "POST" ? route.fulfill({ status: 503, json: { status: "busy" } }) : route.fallback(),
    );
    await page.goto("/");

    await page.getByRole("button", { name: "Start a trial" }).click();

    await expect(page.getByRole("alert")).toHaveText("SchoolGrid is busy right now. Try again in a little while.");
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("button", { name: "Start a trial" })).toBeEnabled();
  });

  test("views the School as each role from the keyboard, landing on each role's home", async ({ page }) => {
    const schoolId = await startTrial(page);
    await expect(banner(page)).toContainText(BANNER);

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

  test("starts over in a fresh School, and the old Session is over", async ({ page, context, playwright }) => {
    const schoolId = await startTrial(page);
    const before = (await context.cookies()).map(({ name, value }) => `${name}=${value}`).join("; ");

    await banner(page).getByRole("button", { name: "Start over" }).click();

    await expect(page).toHaveURL(
      (url) => /^\/schools\/[^/]+\/persons$/.test(url.pathname) && !url.pathname.includes(schoolId),
    );
    await expect(page.getByRole("banner").locator("summary")).toHaveText("Viewing as School Administrator");
    const old = await playwright.request.newContext({ baseURL: SHOWCASE_ORIGIN!, extraHTTPHeaders: { cookie: before } });
    expect(await (await old.get("/api/session")).json()).toEqual({ status: "refused" });
    await old.dispose();
  });

  test("once the trial expires, says it was deleted and starts a new one", async ({ page }) => {
    await page.clock.install();
    await startTrial(page);

    await page.clock.fastForward("02:00:00");
    await expect(page).toHaveURL(/\/trial-ended$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your trial School has been deleted");

    // Back to the time the server keeps, which the new trial's two hours are counted from.
    await page.clock.setSystemTime(Date.now());
    await page.getByRole("button", { name: "Start a new trial" }).click();
    await expect(page).toHaveURL(/\/schools\/[^/]+\/persons$/);
    await expect(banner(page)).toContainText(BANNER);
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
      await expect(page.getByRole("button", { name: "Start a trial" })).toBeVisible();
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
