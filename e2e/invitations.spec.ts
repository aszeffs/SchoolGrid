import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import {
  acknowledgeIssuedLink,
  addPerson,
  issueInvitationFor,
  openSchool,
  openSection,
  peopleRecord,
  pendingInvitations,
  revokeInvitationFor,
  signIn,
} from "./app.ts";
import { seeded } from "./seeded.ts";
import { expect, expectNoSidewaysScroll, test } from "./test.ts";

/**
 * Invitations: what the School is holding open, when each expires, and the way
 * to revoke one. Issuing stays on People, beside the Person it is for.
 *
 * The link is the whole point of the sheet. `issueInvitation` returns it in the
 * one response that will ever carry it, so what is asserted here is that it
 * cannot be lost by accident and cannot be recovered afterwards.
 */

/** A School Administrator in the first School, with a Person of this run's own. */
async function onPeople(page: Page): Promise<string> {
  const { schoolAdministrator, schools } = seeded();
  const displayName = `Casey ${randomUUID().slice(0, 8)}`;
  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[0]!);
  await addPerson(page, displayName);
  return displayName;
}

test("an issued link is shown once, must be acknowledged, and is gone for good afterwards", async ({
  page,
  context,
  baseURL,
  audit,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const displayName = await onPeople(page);
  await issueInvitationFor(page, displayName);

  const field = page.getByLabel("Invitation link");
  await expect(field).toHaveValue(new RegExp(`^${new URL(baseURL!).origin}/invitation#[A-Za-z0-9_-]{43}$`));
  const issued = await field.inputValue();
  // The dialog says plainly that this is the only showing.
  await expect(page.getByRole("dialog")).toContainText("shown only now");

  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(issued);

  // The link is held in a dialog, and the dialog is held to the same bar.
  await audit(page);
  await acknowledgeIssuedLink(page);
  await expect(page.getByLabel("Invitation link")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(issued);

  // The Invitation itself is pending, on its own sheet, and the link is on
  // neither sheet: nothing in the app can produce it again.
  await openSection(page, "Invitations");
  await expect(pendingInvitations(page).filter({ hasText: displayName })).toHaveCount(1);
  await expect(page.locator("body")).not.toContainText(issued);
  await page.reload();
  await expect(pendingInvitations(page).filter({ hasText: displayName })).toHaveCount(1);
  await expect(page.locator("body")).not.toContainText(issued);
  await audit(page);
});

test("a pending Invitation names the Person and when it expires, and revoking it is confirmed", async ({
  page,
}) => {
  const displayName = await onPeople(page);
  await issueInvitationFor(page, displayName);
  await acknowledgeIssuedLink(page);
  await openSection(page, "Invitations");

  const row = pendingInvitations(page).filter({ hasText: displayName });
  // Waited for before it is read: reading the cells outright does not wait for
  // the sheet to have been printed, and would read an empty record as an
  // Invitation that is not there.
  await expect(row).toHaveCount(1);
  // Three values: the Person, when the link stops working, and the way to stop
  // it sooner. The expiry is struck as a date for a reader, carrying a year and
  // a time of day, rather than as the timestamp the API sent. It is not parsed
  // back: the browser formats it in its own locale, down to which space it puts
  // before the meridiem, and none of that is this assertion's business.
  const cells = await row.getByRole("cell").allTextContents();
  expect(cells[0]).toBe(displayName);
  expect(cells[1]).toMatch(/\d{4}/);
  expect(cells[1]).toMatch(/\d{1,2}:\d{2}/);
  expect(cells[1]).not.toContain("T");
  expect(cells[2]).toBe("Revoke");

  await revokeInvitationFor(page, displayName);
  await expect(pendingInvitations(page).filter({ hasText: displayName })).toHaveCount(0);
  // Struck off the server too, not only off the page.
  await page.reload();
  await expect(pendingInvitations(page).filter({ hasText: displayName })).toHaveCount(0);

  // Revoking left the Person, who is Unclaimed and can be invited afresh.
  await openSection(page, "People");
  await expect(peopleRecord(page).filter({ hasText: displayName })).toContainText("Unclaimed");
});

test("with nothing pending the sheet says so and offers the first action", async ({ page, audit }) => {
  const { schoolAdministrator, schools } = seeded();
  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[0]!);

  // Emptied rather than waited for: what else the run has issued in this School
  // is no business of this assertion.
  await page.route("**/api/schools/*/invitations", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 200, json: { invitations: [] } })
      : route.fallback(),
  );
  await openSection(page, "Invitations");

  await expect(page.getByRole("heading", { level: 1, name: "Invitations" })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("No Invitation is pending");
  await audit(page);

  // The first action is offered as a way to People, where an Invitation is issued.
  await page.getByRole("main").getByRole("link", { name: "People" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "People" })).toBeVisible();
});

test("a listing the server will not give is the one not-available sheet", async ({ page }) => {
  const { schoolAdministrator, schools } = seeded();
  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[0]!);

  await page.route("**/api/schools/*/invitations", (route) =>
    route.fulfill({ status: 404, json: { status: "refused" } }),
  );
  await openSection(page, "Invitations");
  await expect(page.getByRole("heading", { name: "Not available" })).toBeVisible();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("the slip holding the link is readable, and the link still copyable", async ({ page, audit }) => {
    const displayName = await onPeople(page);
    await issueInvitationFor(page, displayName);

    // The one thing that cannot be had twice, at the width most of the demo's
    // visitors will meet it at. How the pending record itself stacks is the
    // record primitive's, asserted in sheet-primitives.spec.ts.
    await expect(page.getByLabel("Invitation link")).toBeInViewport();
    await expect(page.getByRole("button", { name: "Copy link" })).toBeInViewport();
    await expectNoSidewaysScroll(page);
    await audit(page);
    await acknowledgeIssuedLink(page);
  });
});
