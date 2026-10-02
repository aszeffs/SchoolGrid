import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * The landing page tour's screenshots: each feature on the page that shows
 * it, as the role that sees it, in a Trial School started through the
 * sign-in as a visitor would start one. Each is written in the light and the
 * dark rendition, since the landing page shows whichever the browser asks
 * for (ADR-0010).
 */
const OUT = new URL("../../web/public/tour/", import.meta.url);

/** Starts a Trial School through the stand-in provider, as a fresh visitor, and lands in it as its School Administrator. */
async function startTrial(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByRole("link", { name: "Continue with GitHub" }).click();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page).toHaveURL(/\/schools\/[^/]+\/persons$/);
  // The banner counts down from the moment the trial started: held at its
  // start, so a rerun redraws the same words.
  const expiresAt = await page.getByRole("region", { name: "Trial School" }).locator("time").getAttribute("datetime");
  await page.clock.setFixedTime(Date.parse(expiresAt!) - 2 * 60 * 60 * 1000);
  await expect(page.getByRole("region", { name: "Trial School" })).toContainText("deleted in 2h 0m");
  return new URL(page.url()).pathname.split("/")[2]!;
}

/** Waits for the sheet to finish being read. */
async function settled(page: Page) {
  await expect(page.getByRole("main")).not.toHaveAttribute("aria-busy", "true");
}

async function viewAs(page: Page, name: string) {
  await settled(page);
  await page.getByRole("banner").locator("summary", { hasText: /^Viewing as / }).click();
  await page.getByRole("list", { name: "View this School as" }).getByRole("button", { name }).click();
  await expect(page.getByRole("banner").locator("summary")).toHaveText(`Viewing as ${name}`);
  await settled(page);
}

/** Writes the page as it stands in both renditions, as `<feature>-light.png` and `<feature>-dark.png`. */
async function shoot(page: Page, feature: string) {
  // Off anything the last click left it hovering.
  await page.mouse.move(0, 0);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await settled(page);
    // Two frames painted in this rendition before it is taken.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await page.screenshot({ path: fileURLToPath(new URL(`${feature}-${colorScheme}.png`, OUT)) });
  }
}

/** Opens one of the Faculty role's classes, as that role. */
async function openClass(page: Page, name: string) {
  await viewAs(page, "Faculty");
  await page.getByRole("navigation").getByRole("link", { name: "Your classes" }).click();
  await page.getByRole("link", { name }).first().click();
  await settled(page);
}

/** Scrolls the sheet so it opens on this, under the banner. */
async function scrollTo(page: Page, heading: string) {
  await page.getByRole("heading", { level: 2, name: heading, exact: true }).evaluate((node) => {
    node.scrollIntoView();
    window.scrollBy(0, -32);
  });
}

test("attendance: today's Attendance session, everyone marked Present in one action, as Faculty", async ({ page }) => {
  await startTrial(page);
  await openClass(page, "Mathematics, Section B");
  await page.getByRole("link", { name: /Attendance/ }).first().click();
  await settled(page);
  await page.getByRole("button", { name: "Mark all Present" }).click();
  await expect(page.getByRole("button", { name: "Mark all Present" })).toBeDisabled();
  // One exception, changed and not yet saved.
  await page.getByRole("combobox", { name: /^Riley Fernsby/ }).selectOption({ label: "Tardy" });
  await scrollTo(page, "Attendance");
  await shoot(page, "attendance");
});

test("publication: publishing a Class Offering's Term results, as Faculty", async ({ page }) => {
  await startTrial(page);
  await openClass(page, "Mathematics, Section B");
  await page.getByRole("link", { name: /Term results/ }).first().click();
  await settled(page);
  await page.getByRole("button", { name: "Publish results" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await shoot(page, "publication");
});

test("guardian: the Student's Term report, as their Guardian", async ({ page }) => {
  await startTrial(page);
  await viewAs(page, "Guardian");
  await page.getByRole("link", { name: /Term report/ }).first().click();
  await settled(page);
  await shoot(page, "guardian");
});

test("security: the School's Audit trail, as its School Administrator", async ({ page }) => {
  await startTrial(page);
  // A few things worth a record: a look as another role, and a Correction request approved.
  await viewAs(page, "Faculty");
  await viewAs(page, "School Administrator");
  await page.getByRole("navigation").getByRole("link", { name: "Correction requests" }).click();
  await settled(page);
  await page.getByRole("button", { name: /^Approve / }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Approve/ }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("navigation").getByRole("link", { name: "Audit" }).click();
  await settled(page);
  await shoot(page, "security");
});
