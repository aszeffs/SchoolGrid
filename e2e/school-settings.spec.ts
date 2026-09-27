import type { Page } from "@playwright/test";
import { openSchool, openSection, schoolIdOf, signIn } from "./app.ts";
import { seeded } from "./seeded.ts";
import { expect, expectNoSidewaysScroll, test } from "./test.ts";

/**
 * School settings: where a School Administrator reads and corrects the
 * School's timezone and its Attendance window. Which School date an instant
 * falls on, and which dates a window change opens or closes, are the HTTP
 * suite's to assert; this is about the page.
 *
 * The second seeded School is used throughout, so changing its timezone
 * touches nothing another spec reads.
 */

/** The School's timezone as the sheet states it. */
function timezoneShown(page: Page) {
  return page.getByRole("main").locator(".facts dd").first();
}

/** A School Administrator on the second School's settings, with its timezone and window put back to the seeded ones. */
async function onSettings(page: Page): Promise<{ schoolId: string }> {
  const { schoolAdministrator, schools } = seeded();
  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[1]!);
  const schoolId = await schoolIdOf(page, schools[1]!);
  const restored = await page.request.patch(`/api/schools/${schoolId}/settings`, {
    headers: { origin: new URL(page.url()).origin },
    data: { timezone: "Europe/London", attendanceWindow: 7 },
  });
  expect(restored.ok()).toBe(true);
  await openSection(page, "Settings");
  await expect(page.getByRole("heading", { level: 1, name: "School settings" })).toBeVisible();
  return { schoolId };
}

test("the School's timezone is shown, and changing it is kept", async ({ page, audit }) => {
  await onSettings(page);
  await expect(timezoneShown(page)).toHaveText("Europe/London");
  const form = page.getByRole("form", { name: "Change the timezone" });
  await expect(form.getByLabel("Timezone")).toHaveValue("Europe/London");
  await audit(page);

  const patched = page.waitForRequest((request) => request.method() === "PATCH");
  await form.getByLabel("Timezone").selectOption("America/Chicago");
  await form.getByRole("button", { name: "Change timezone" }).click();
  expect((await patched).postDataJSON()).toEqual({ timezone: "America/Chicago" });

  await expect(timezoneShown(page)).toHaveText("America/Chicago");
  await expect(page.getByRole("status")).toHaveText("The School now keeps its days in America/Chicago.");
  await expect(form.getByLabel("Timezone")).toHaveValue("America/Chicago");

  // What the sheet shows is what the server holds.
  await page.reload();
  await expect(timezoneShown(page)).toHaveText("America/Chicago");
});

test("the timezone is changed from the keyboard alone, with focus in sight", async ({ page }) => {
  await onSettings(page);
  const select = page.getByRole("form", { name: "Change the timezone" }).getByLabel("Timezone");

  await select.focus();
  await expect(select).toBeFocused();
  // Down from London, in the order the options run.
  await page.keyboard.press("ArrowDown");
  const chosen = await select.inputValue();
  expect(chosen).not.toBe("Europe/London");
  await page.keyboard.press("Tab");
  const button = page.getByRole("button", { name: "Change timezone" });
  await expect(button).toBeFocused();
  expect(await button.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe("none");
  await page.keyboard.press("Enter");

  await expect(timezoneShown(page)).toHaveText(chosen);
});

test("the Attendance window changes only once its confirmation names what it closes", async ({ page, audit }) => {
  await onSettings(page);
  const windowShown = page.getByRole("main").locator(".facts dd").nth(1);
  await expect(windowShown).toHaveText("7 days");
  // Which dates close depends on the day the suite runs, so the count is the server's to be trusted with.
  await page.route("**/settings/attendance-window-preview?*", (route) =>
    route.fulfill({ status: 200, json: { opens: 0, closes: 4 } }),
  );
  const form = page.getByRole("form", { name: "Change the Attendance window" });
  const patches: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH") {
      patches.push(request.postDataJSON());
    }
  });

  await form.getByLabel("Days after a School date").fill("3");
  await form.getByRole("button", { name: "Review change" }).click();
  const dialog = page.getByRole("dialog", { name: "Change the Attendance window?" });
  await expect(dialog).toContainText("up to 3 days after its School date, instead of up to 7 days");
  await expect(dialog).toContainText("This closes 4 past Instructional days.");
  await audit(page);

  // Escape cancels, and sends nothing.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(windowShown).toHaveText("7 days");
  expect(patches).toEqual([]);

  await form.getByRole("button", { name: "Review change" }).click();
  await dialog.getByRole("button", { name: "Change the window" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(windowShown).toHaveText("3 days");
  await expect(page.getByRole("status")).toHaveText(
    "Attendance can now be recorded up to 3 days after its School date.",
  );
  expect(patches).toEqual([{ attendanceWindow: 3 }]);
});

test("navigation offers Settings only to a School Administrator", async ({ page }) => {
  const { faculty, schools } = seeded();
  await signIn(page, faculty);
  await expect(page.getByRole("navigation")).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("link", { name: "Settings" })).toHaveCount(0);

  // And opened from its URL anyway, the page is the one refusal.
  const schoolId = await schoolIdOf(page, schools[0]!);
  await page.goto(`/schools/${schoolId}/settings`);
  await expect(page.getByRole("heading", { level: 1, name: "Not available" })).toBeVisible();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the sheet holds 360px in the ${colorScheme} rendition`, async ({ page, audit }) => {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await onSettings(page);
      for (const name of ["Change timezone", "Review change"]) {
        const button = page.getByRole("button", { name });
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeInViewport();
      }
      await expectNoSidewaysScroll(page);
      await audit(page);
    });
  }
});
