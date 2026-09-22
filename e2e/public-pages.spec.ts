import type { Page } from "@playwright/test";
import { expect, test } from "./test.ts";

/**
 * The two sheets a visitor sees before signing in: the demo's front door.
 *
 * What each page says about the domain belongs to its own spec — the demo's
 * roles to try-a-role.spec.ts, the build's provenance to
 * how-this-was-built.spec.ts. What is asserted here is what both owe a
 * visitor who arrives on them cold: that they explain themselves, that they
 * can be worked by the keyboard, that they hold 360px, and that they print on
 * their own stock whichever theme the browser asks for.
 */

const PUBLIC_SHEETS = [
  { path: "/sign-in", heading: "Sign in to SchoolGrid", stock: "rgb(247, 231, 166)" },
  { path: "/how-this-was-built", heading: "How this was built", stock: "rgb(203, 224, 206)" },
] as const;

/** Whether the element with the focus draws a ring, rather than taking it invisibly. */
async function focusRingIsVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) {
      return false;
    }
    const { outlineStyle, outlineWidth } = getComputedStyle(active);
    return outlineStyle !== "none" && Number.parseFloat(outlineWidth) > 0;
  });
}

test("sign-in says what SchoolGrid is before it asks for credentials", async ({ page }) => {
  await page.goto("/sign-in");

  const explanation = page.getByRole("main").getByText(/academic records/);
  await expect(explanation).toBeVisible();

  // Above the form, not below it: it is read before the fields are reached.
  const explanationTop = await explanation.first().evaluate((node) => node.getBoundingClientRect().top);
  const formTop = await page.locator("form").evaluate((node) => node.getBoundingClientRect().top);
  expect(explanationTop).toBeLessThan(formTop);
});

test("sign-in is worked by the keyboard alone, and every stop shows its focus", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in to SchoolGrid" })).toBeVisible();

  const reached: string[] = [];
  // Enough presses to cross the head and the form, whatever the head carries.
  for (let press = 0; press < 12 && !reached.includes("Sign in"); press += 1) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const active = document.activeElement;
      if (active === null || active === document.body) {
        return undefined;
      }
      return (active.getAttribute("name") ?? active.textContent ?? "").trim();
    });
    if (stop !== undefined && stop !== "") {
      expect(await focusRingIsVisible(page), `no focus ring on ${stop}`).toBe(true);
      reached.push(stop);
    }
  }

  expect(reached).toEqual(expect.arrayContaining(["username", "password", "Sign in"]));
});

for (const { path, heading, stock } of PUBLIC_SHEETS) {
  test(`${path} holds 360px with no sideways scroll`, async ({ page, audit }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
      "the sheet scrolls sideways at 360px",
    ).toBe(false);
    await audit(page);
  });

  test.describe(`${path} in a dark browser`, () => {
    test.use({ colorScheme: "dark" });

    test("prints on its own stock rather than inverting", async ({ page, audit }) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();

      // Paper does not invert: the stocks carry the whole range, so a browser
      // asking for dark gets the same sheet, and axe still finds the contrast.
      // Asserted on the sheet, which is what floods the frame; `body` behind
      // it carries the default stock whichever sheet is run.
      await expect(page.locator(".sheet")).toHaveCSS("background-color", stock);
      await audit(page);
    });
  });
}
