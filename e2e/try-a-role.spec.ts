import { expect, test } from "./test.ts";

/**
 * Where scripts/smoke-test.sh serves the same image with DEMO_MODE on, against
 * the database it has run demo/seed.sql into. Every other test drives the
 * image with it off, as every deployment but the public demo runs.
 */
const DEMO_ORIGIN = process.env["SCHOOLGRID_DEMO_ORIGIN"];

const ROLES = ["School Administrator", "Faculty", "Student", "Guardian"];

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
    await expect(page.getByText("resets every night")).toBeVisible();
  });

  for (const role of ROLES) {
    test(`signs in as the ${role} in one click`, async ({ page }) => {
      await page.goto("/sign-in");
      await page.getByRole("button", { name: `Sign in as ${role}`, exact: true }).click();

      // Each demo account reaches the one School, so lands straight inside it.
      await expect(page).toHaveURL(/\/schools\/[^/]+\/persons$/);
      await expect(page.getByRole("banner").getByText("Riverbend Demo School", { exact: true })).toBeVisible();
    });
  }
});
