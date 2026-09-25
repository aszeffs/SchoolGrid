import type { Page } from "@playwright/test";
import { expect, expectNoSidewaysScroll, test } from "./test.ts";

/**
 * The sheets a visitor sees before signing in: the site's front door.
 *
 * What each page says about the domain belongs to its own spec — a trial to
 * trial-school.spec.ts, the build's provenance to how-this-was-built.spec.ts.
 * What is asserted here is what all of them owe a visitor who arrives on
 * them cold: that they explain themselves, that they can be worked by the
 * keyboard, that they hold 360px, and that they follow the theme the browser
 * asks for and stay legible in both.
 */

const PUBLIC_SHEETS = [
  { path: "/", heading: "Academic records for K-12 Schools" },
  { path: "/sign-in", heading: "Sign in to SchoolGrid" },
  { path: "/how-this-was-built", heading: "How this was built" },
] as const;

/** The element that fills the frame, and so the one carrying the page's ground. */
const sheet = (page: Page) => page.locator(".sheet");

/** What the element holding the focus is, as a name a failure can be read by. */
async function focused(page: Page): Promise<{ name: string; ring: string } | undefined> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) {
      return undefined;
    }
    const { outlineStyle, outlineWidth } = getComputedStyle(active);
    return {
      name: (active.getAttribute("name") ?? active.textContent ?? "").trim(),
      ring: `${outlineStyle} ${outlineWidth}`,
    };
  });
}

test("the landing page says what SchoolGrid is, how it holds records, and that it is a showcase", async ({ page }) => {
  await page.goto("/");

  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("Academic records for K-12 Schools");
  await expect(main.getByText(/School Administrator runs the School/)).toBeVisible();

  const trust = page.getByRole("region", { name: "Trust & security" });
  for (const term of ["Records isolated per School", "Audit trail", "Signed and verified builds"]) {
    await expect(trust.getByRole("term").filter({ hasText: term })).toBeVisible();
  }
  await trust.getByRole("link", { name: "How this was built" }).click();
  await expect(page).toHaveURL("/how-this-was-built");
  await page.goBack();

  await expect(
    main.getByText(
      "SchoolGrid is a showcase project. It doesn't host real Schools, and every record in a trial is invented.",
    ),
  ).toBeVisible();
  await expect(main.getByRole("link", { name: "GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/aszeffs/SchoolGrid",
  );
  // Nothing on it frames the site as anything but the product it shows.
  await expect(page.locator("body")).not.toContainText(/learn|practice|portfolio|DevSecOps/i);

  // This deployment offers no trial, so the page offers none.
  await expect(main.getByRole("button", { name: "Start a trial" })).toHaveCount(0);
  await main.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/sign-in");
});

test("the landing page is worked by the keyboard alone, and every stop shows the ring", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  const reached: string[] = [];
  for (let press = 0; press < 12 && !reached.includes("Sign in"); press += 1) {
    await page.keyboard.press("Tab");
    const stop = await focused(page);
    if (stop !== undefined && stop.name !== "") {
      expect(stop.ring, `the focus ring on ${stop.name}`).toBe("solid 3px");
      reached.push(stop.name);
    }
  }

  expect(reached).toEqual(expect.arrayContaining(["How this was built", "GitHub", "Sign in"]));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/sign-in");
});

test("sign-in says what SchoolGrid is before it asks for credentials", async ({ page }) => {
  await page.goto("/sign-in");

  const explanation = page.getByRole("main").getByText(/academic records/);
  await expect(explanation).toBeVisible();

  // Above the form, not below it: it is read before the fields are reached.
  const explanationTop = await explanation.first().evaluate((node) => node.getBoundingClientRect().top);
  const formTop = await page.locator("form").evaluate((node) => node.getBoundingClientRect().top);
  expect(explanationTop).toBeLessThan(formTop);
});

test("sign-in is worked by the keyboard alone, and every stop shows the ring", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in to SchoolGrid" })).toBeVisible();

  const reached: string[] = [];
  // Enough presses to cross the head and the form, whatever the head carries.
  for (let press = 0; press < 12 && !reached.includes("Sign in"); press += 1) {
    await page.keyboard.press("Tab");
    const stop = await focused(page);
    if (stop !== undefined && stop.name !== "") {
      // The ring the design system states: 3px solid ink, not merely something.
      expect(stop.ring, `the focus ring on ${stop.name}`).toBe("solid 3px");
      reached.push(stop.name);
    }
  }

  expect(reached).toEqual(expect.arrayContaining(["username", "password", "Sign in"]));
});

for (const { path, heading } of PUBLIC_SHEETS) {
  test(`${path} holds 360px with no sideways scroll`, async ({ page, audit }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();

    await expectNoSidewaysScroll(page);
    await audit(page);
  });

  test(`${path} follows a dark browser, and stays legible in both themes`, async ({ page, audit }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();

    // Two renditions, picked by the browser's setting (ADR-0010). Asserted
    // against the page's own light rendition rather than against a colour
    // written down here, which would only restate what styles.css already says.
    await page.emulateMedia({ colorScheme: "light" });
    const inLight = await sheet(page).evaluate((node) => {
      const { backgroundColor, color } = getComputedStyle(node);
      return { backgroundColor, color };
    });
    await audit(page);

    // With motion reduced, so the switch lands at once: audited mid-transition,
    // a button fading between its two renditions fails contrast in neither.
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await expect(sheet(page)).not.toHaveCSS("background-color", inLight.backgroundColor);
    await expect(sheet(page)).not.toHaveCSS("color", inLight.color);
    // Two frames painted in the dark rendition before it is audited: read the
    // moment the scheme flips, axe can still see text drawn in the light one.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    // And the dark rendition clears the same contrast bar the light one does.
    await audit(page);
  });
}
