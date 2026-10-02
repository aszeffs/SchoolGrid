import type { Page } from "@playwright/test";
import { openSchool, openSection, schoolIdOf, signIn } from "./app.ts";
import { seeded } from "./seeded.ts";
import { expect, expectNoSidewaysScroll, test } from "./test.ts";

/**
 * School settings: where a School Administrator reads and corrects the
 * School's timezone, its Attendance window, and its Result value scale. Which School date an instant
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

/**
 * A School Administrator on the second School's settings, with its timezone
 * and window put back to the seeded ones, and its Result value scale to A to F.
 * A scale is never put back as such: A to F is saved again as a new version,
 * unless it is what the School already holds.
 */
async function onSettings(page: Page): Promise<{ schoolId: string }> {
  const { schoolAdministrator, schools } = seeded();
  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[1]!);
  const schoolId = await schoolIdOf(page, schools[1]!);
  const headers = { origin: new URL(page.url()).origin };
  const restored = await page.request.patch(`/api/schools/${schoolId}/settings`, {
    headers,
    data: { timezone: "Europe/London", attendanceWindow: 7 },
  });
  expect(restored.ok()).toBe(true);
  const scale = await page.request.post(`/api/schools/${schoolId}/result-value-scale`, {
    headers,
    data: { values: ["A", "B", "C", "D", "F"].map((label) => ({ label })) },
  });
  expect([201, 409]).toContain(scale.status());
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

test("the Result value scale is edited in place and saved as a new version", async ({ page, audit }) => {
  await onSettings(page);
  const section = page.getByRole("region", { name: "Result value scale" });
  const shown = section.locator(".scale-values li");
  await expect(shown).toHaveText(["A", "B", "C", "D", "F"]);
  const version = Number((await section.getByText(/^Version \d+\./).textContent())!.match(/\d+/)![0]);
  const form = page.getByRole("form", { name: "Change the Result value scale" });
  const posts: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/result-value-scale")) {
      posts.push(request.postDataJSON());
    }
  });

  // Two labels the same but for letter case are caught before anything is sent.
  await form.getByRole("group", { name: "Value 5" }).getByLabel("Label").fill("d");
  await form.getByRole("button", { name: "Review scale" }).click();
  await expect(form.getByRole("alert")).toHaveText(
    "Values 4 and 5 are both labelled d. Each label must differ, ignoring letter case.",
  );
  await form.getByRole("group", { name: "Value 5" }).getByLabel("Label").fill("F");

  // Add a value, describe it, and move it to the top from the keyboard.
  await form.getByRole("button", { name: "Add a value" }).click();
  const added = form.getByRole("group", { name: "Value 6" });
  await expect(added.getByLabel("Label")).toBeFocused();
  await page.keyboard.type("A+");
  await added.getByLabel("Description (optional)").fill("With distinction");
  await form.getByRole("button", { name: "Move value 6 up" }).focus();
  for (let press = 0; press < 5; press += 1) {
    await page.keyboard.press("Enter");
  }
  // At the top it can move up no further, so the focus is on the way down.
  await expect(form.getByRole("button", { name: "Move value 1 down" })).toBeFocused();
  await expect(form.getByRole("group", { name: "Value 1" }).getByLabel("Label")).toHaveValue("A+");
  await form.getByRole("button", { name: "Remove value 5" }).click();

  await form.getByRole("button", { name: "Review scale" }).click();
  const dialog = page.getByRole("dialog", { name: "Save a new version of the scale?" });
  await expect(dialog).toContainText(`Version ${version + 1} will hold A+, A, B, C, F, in that order.`);
  await audit(page);
  await dialog.getByRole("button", { name: `Save version ${version + 1}` }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText(`Version ${version + 1} of the Result value scale is saved.`);
  await expect(shown).toHaveText(["A+ — With distinction", "A", "B", "C", "F"]);
  expect(posts).toEqual([
    {
      values: [
        { label: "A+", description: "With distinction" },
        ...["A", "B", "C", "F"].map((label) => ({ label, description: null })),
      ],
    },
  ]);

  // What the sheet shows is what the server holds.
  await page.reload();
  await expect(shown).toHaveText(["A+ — With distinction", "A", "B", "C", "F"]);
  await expect(section.getByText(`Version ${version + 1}.`, { exact: false })).toBeVisible();
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
      for (const name of ["Change timezone", "Review change", "Move value 1 down", "Review scale"]) {
        const button = page.getByRole("button", { name });
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeInViewport();
      }
      await expectNoSidewaysScroll(page);
      await audit(page);
    });
  }
});
