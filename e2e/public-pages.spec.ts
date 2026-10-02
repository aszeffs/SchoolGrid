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

const HEADLINE = "A K-12 School's attendance and results, each seen by the right role";

/** The landing page's tour, in the order it leads with, and the role each feature is seen as. */
const TOUR = [
  { heading: "Attendance in a few clicks", role: "Faculty" },
  { heading: "Term results, published safely", role: "Faculty" },
  { heading: "Guardians see only what they're granted", role: "Guardian" },
  { heading: "Security and audit", role: "School Administrator" },
] as const;

const PUBLIC_SHEETS = [
  { path: "/", heading: HEADLINE },
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

test("the landing page says what SchoolGrid does, tours what each role sees, and that it is a showcase", async ({
  page,
}) => {
  await page.goto("/");

  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText(HEADLINE);

  // The tour leads with what a School does every day, and ends on how its records are held.
  await expect(main.getByRole("heading", { level: 2 })).toHaveText(TOUR.map(({ heading }) => heading));
  for (const { heading, role } of TOUR) {
    await expect(main.getByRole("region", { name: heading }).getByText(`Seen as ${role}`, { exact: true })).toBeVisible();
  }

  const security = main.getByRole("region", { name: "Security and audit" });
  for (const term of ["Records isolated per School", "Audit trail", "Signed and verified builds"]) {
    await expect(security.getByRole("term").filter({ hasText: term })).toBeVisible();
  }
  await security.getByRole("link", { name: "How this was built" }).click();
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
  // Nothing on it frames the site as anything but the product it shows, and
  // nothing asks for money: the one way in is a trial.
  await expect(page.locator("body")).not.toContainText(/learn|practice|portfolio|DevSecOps/i);
  await expect(page.locator("body")).not.toContainText(/\b(pric(e|es|ing)|plans?|subscri\w*|contact sales)\b/i);

  // This deployment offers no trial, so the page offers none.
  await expect(main.getByRole("link", { name: /^Continue with / })).toHaveCount(0);
  await main.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/sign-in");
});

test("the tour shows each feature as the app draws it, in the browser's own rendition", async ({ page, audit }) => {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.goto("/");

    for (const { heading } of TOUR) {
      const screenshot = page.getByRole("region", { name: heading }).getByRole("img");
      // Described for whoever cannot see it, not merely labelled.
      await expect(screenshot).toHaveAttribute("alt", /\w+( \w+){4,}/);
      // Lazy, so it loads only once it is near.
      await screenshot.scrollIntoViewIfNeeded();
      await expect
        .poll(() => screenshot.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0))
        .toBe(true);
      expect(await screenshot.evaluate((image: HTMLImageElement) => image.currentSrc)).toMatch(
        new RegExp(`/tour/[a-z]+-${colorScheme}\\.png$`),
      );
    }
    await audit(page);
  }
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
