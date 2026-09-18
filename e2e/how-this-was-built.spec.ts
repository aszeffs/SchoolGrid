import type { Page } from "@playwright/test";
import { expect, test } from "./test.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = `sha256:${"ab".repeat(32)}`;

/** Answers the page's request for build info with this body, whatever the server knows. */
async function serveBuildInfo(page: Page, body: object): Promise<void> {
  await page.route("**/api/build-info", (route) => route.fulfill({ json: body }));
}

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

test("with a commit and digest, it links both and gives the command to verify them", async ({ page }) => {
  await serveBuildInfo(page, { commit: COMMIT, digest: DIGEST });
  await page.goto("/how-this-was-built");

  await expect(fact(page, "Commit").getByRole("link", { name: COMMIT })).toHaveAttribute(
    "href",
    `https://github.com/aszeffs/SchoolGrid/commit/${COMMIT}`,
  );
  await expect(fact(page, "Image digest")).toHaveText(DIGEST);
  await expect(page.getByRole("link", { name: /GitHub Container Registry/ })).toHaveAttribute(
    "href",
    "https://github.com/aszeffs/SchoolGrid/pkgs/container/schoolgrid",
  );
  await expect(page.getByRole("link", { name: /attestations/ })).toHaveAttribute(
    "href",
    "https://github.com/aszeffs/SchoolGrid/attestations",
  );

  // Exactly what a visitor pastes into a shell, continuation lines and all.
  await expect(page.getByLabel("Verify command")).toHaveText(
    [
      `gh attestation verify oci://ghcr.io/aszeffs/schoolgrid@${DIGEST} \\`,
      "  --repo aszeffs/SchoolGrid \\",
      "  --signer-workflow aszeffs/SchoolGrid/.github/workflows/container.yml \\",
      "  --source-ref refs/heads/main \\",
      `  --source-digest ${COMMIT} \\`,
      "  --deny-self-hosted-runners",
    ].join("\n"),
    { useInnerText: true },
  );
});

test("with neither, it says so rather than showing placeholders or a command", async ({ page }) => {
  await serveBuildInfo(page, {});
  await page.goto("/how-this-was-built");

  await expect(fact(page, "Commit")).toContainText("Not recorded");
  await expect(fact(page, "Image digest")).toContainText("Not recorded");
  await expect(page.getByLabel("Verify command")).toHaveCount(0);
  await expect(page.getByText("no command to verify")).toBeVisible();
  await expect(page.locator("main")).not.toContainText(/undefined|null|<digest>|sha256:/);
});

test("with a commit but no digest, it links the commit and gives no command", async ({ page }) => {
  await serveBuildInfo(page, { commit: COMMIT });
  await page.goto("/how-this-was-built");

  await expect(fact(page, "Commit").getByRole("link")).toHaveText(COMMIT);
  await expect(fact(page, "Image digest")).toContainText("Not recorded");
  await expect(page.getByLabel("Verify command")).toHaveCount(0);
});

test("a failed request shows the page is not available", async ({ page }) => {
  await page.route("**/api/build-info", (route) => route.fulfill({ status: 503 }));
  await page.goto("/how-this-was-built");

  await expect(page.getByRole("heading", { name: "Not available" })).toBeVisible();
});
