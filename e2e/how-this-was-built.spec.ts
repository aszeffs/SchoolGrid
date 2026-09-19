import type { Page } from "@playwright/test";
import { expect, test } from "./test.ts";

function fact(page: Page, name: string) {
  return page.locator("dt", { hasText: name }).locator("xpath=following-sibling::dd[1]");
}

test("the page is reachable from sign-in without signing in, and shows what the server reports", async ({
  page,
}) => {
  await page.goto("/sign-in");
  await page.getByRole("link", { name: "How this was built" }).click();

  await expect(page).toHaveURL("/how-this-was-built");
  await expect(page.getByRole("heading", { name: "How this was built" })).toBeVisible();

  const reported = (await (await page.request.get("/api/build-info")).json()) as {
    commit?: string;
    digest?: string;
  };
  if (reported.commit === undefined) {
    await expect(fact(page, "Commit")).toContainText("Not recorded");
  } else {
    await expect(fact(page, "Commit").getByRole("link")).toHaveText(reported.commit);
  }
  if (reported.digest === undefined) {
    await expect(fact(page, "Image digest")).toContainText("Not recorded");
  } else {
    await expect(fact(page, "Image digest")).toHaveText(reported.digest);
  }
});

test("the image under test shows the commit it was built from", async ({ page }) => {
  const expected = process.env["SCHOOLGRID_EXPECTED_COMMIT"];
  test.skip(expected === undefined || expected === "", "only CI knows which commit the image was built from");

  await page.goto("/how-this-was-built");

  await expect(fact(page, "Commit").getByRole("link")).toHaveText(expected!);
});
