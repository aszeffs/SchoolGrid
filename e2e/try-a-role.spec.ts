import { expect, test } from "./test.ts";

/**
 * Where scripts/smoke-test.sh serves the same image with DEMO_MODE on, against
 * the database it has run demo/seed.sql into. Every other test drives the
 * image with it off, as every deployment but the public demo runs.
 */
const DEMO_ORIGIN = process.env["SCHOOLGRID_DEMO_ORIGIN"];

const ROLES = ["School Administrator", "Faculty", "Student", "Guardian"];

/** What the panel promises a visitor about the data behind every role. */
const ABOUT_THE_DATA = [/invented/i, /anyone can change/i, /resets every night/i];

/**
 * The parts of the glossary whose screens are not built. A role's line may
 * name one only to say so: Students and Guardians reach nothing but their own
 * account and People (SECTIONS in web/src/routes.ts), and a line selling the
 * academic screens would mis-sell them.
 */
const NOT_BUILT = /Attendance|Term result|published academic records/;

test("without demo mode the sign-in page offers no roles to try", async ({ page }) => {
  // Asserted once the page has been told there are none, or an absent panel
  // would pass merely by being checked for before the answer arrived.
  const answered = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/demo");
  await page.goto("/sign-in");
  expect(await (await answered).json()).toEqual({ accounts: [] });
  await expect(page.getByRole("heading", { name: "Sign in to SchoolGrid" })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Try a role" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Sign in as / })).toHaveCount(0);
});

test.describe("with demo mode on", () => {
  test.skip(DEMO_ORIGIN === undefined || DEMO_ORIGIN === "", "only the smoke test serves a demo");
  test.use({ baseURL: DEMO_ORIGIN });

  test("the sign-in page offers each School role, and says the data resets", async ({ page }) => {
    await page.goto("/sign-in");

    await expect(page.getByRole("heading", { name: "Try a role" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Sign in as / })).toHaveText(
      ROLES.map((role) => `Sign in as ${role}`),
    );
    for (const statement of ABOUT_THE_DATA) {
      await expect(page.getByRole("main").getByText(statement)).toBeVisible();
    }
  });

  test("each role is offered with a line on what that role sees", async ({ page }) => {
    await page.goto("/sign-in");

    for (const role of ROLES) {
      const described = await page
        .getByRole("button", { name: `Sign in as ${role}`, exact: true })
        .evaluate((button) => {
          const id = button.getAttribute("aria-describedby");
          return id === null ? undefined : document.getElementById(id)?.textContent?.trim();
        });
      expect(described, `no line on what the ${role} sees`).toBeTruthy();
      expect(described!.length, `the line on the ${role} is not short`).toBeLessThan(160);

      // A line may name an unbuilt part of the glossary only to say it is not
      // built. Offering it as something the role sees would be a promise the
      // demo does not keep.
      if (NOT_BUILT.test(described!)) {
        expect(described, `the line on the ${role} offers a screen that is not built`).toMatch(
          /not built yet/,
        );
      }
    }
  });

  for (const role of ROLES) {
    test(`signs in as the ${role} in one click`, async ({ page }) => {
      await page.goto("/sign-in");
      await page.getByRole("button", { name: `Sign in as ${role}`, exact: true }).click();

      // Each demo account reaches the one School, so lands straight inside it:
      // the School Administrator on its People, every other role on their own
      // account (landing in web/src/routes.ts).
      const opensOn = role === "School Administrator" ? "persons" : "account";
      await expect(page).toHaveURL(new RegExp(`/schools/[^/]+/${opensOn}$`));
      await expect(page.getByRole("banner").getByText("Riverbend Demo School", { exact: true })).toBeVisible();
    });
  }
});
