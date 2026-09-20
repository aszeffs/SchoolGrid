import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { seeded } from "./seeded.ts";
import { expect, test } from "./test.ts";

/**
 * The two primitives the sheet is built from, driven where the app already
 * uses them: the slip held over the sheet, and the record of several columns.
 *
 * What is asserted here is the primitive's behaviour, not the Invitation's.
 * What issuing and revoking an Invitation mean is covered in web-app.spec.ts
 * and at the HTTP seam.
 */

/** A School Administrator on the Persons sheet, with one Person invited. */
async function invited(page: Page): Promise<string> {
  const { schoolAdministrator, schools } = seeded();
  const displayName = `Alex ${randomUUID().slice(0, 8)}`;

  await page.goto("/sign-in");
  await page.getByLabel("Username").fill(schoolAdministrator.username);
  await page.getByLabel("Password").fill(schoolAdministrator.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("list", { name: "Schools" }).getByRole("link", { name: schools[0]! }).click();
  await page.getByLabel("Display name").fill(displayName);
  await page.getByRole("button", { name: "Add Person" }).click();
  await page.getByRole("button", { name: `Invite ${displayName}` }).click();
  return displayName;
}

function revokeButtonFor(page: Page, displayName: string) {
  return page.getByRole("button", { name: `Revoke the Invitation for ${displayName}` });
}

test("the issued link's dialog closes only on acknowledgement, not on Escape or a click beside it", async ({
  page,
}) => {
  await invited(page);
  const link = page.getByLabel("Invitation link");
  await expect(link).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(link).toBeVisible();

  // Beside the slip, on the veil over the sheet.
  await page.mouse.click(4, 4);
  await expect(link).toBeVisible();

  await page.getByRole("button", { name: "Done" }).click();
  await expect(link).toHaveCount(0);
});

test("a dialog takes focus, holds it, and hands it back to the control that opened it", async ({ page }) => {
  const displayName = await invited(page);
  await page.getByRole("button", { name: "Done" }).click();

  await revokeButtonFor(page, displayName).click();
  // Cancel holds the focus: the consequence is read before the key that
  // confirms it is under the hand.
  await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();

  // Tabbing never reaches the sheet behind, however far it is pressed. Between
  // cycles the browser parks the focus on the document itself, which is not a
  // control and cannot act; what must never happen is a control behind the
  // slip taking it.
  for (let press = 0; press < 8; press += 1) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => {
        const active = document.activeElement;
        return active !== null && active !== document.body && active.closest("dialog") === null;
      }),
      `focus reached the sheet behind after ${press + 1} presses`,
    ).toBe(false);
  }

  // Nor will the sheet behind take the focus when it is handed it outright:
  // opening the slip made the rest of the page inert.
  expect(
    await page.evaluate(() => {
      const behind = document.querySelector<HTMLInputElement>('input[name="displayName"]');
      behind?.focus();
      return behind !== null && document.activeElement === behind;
    }),
    "a field on the sheet behind took the focus",
  ).toBe(false);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await expect(revokeButtonFor(page, displayName)).toBeFocused();
});

test("cancelling a confirmation leaves the server as it was", async ({ page }) => {
  const displayName = await invited(page);
  await page.getByRole("button", { name: "Done" }).click();
  const pending = page.getByRole("table", { name: "Pending Invitations" }).getByRole("row");

  await revokeButtonFor(page, displayName).click();
  await expect(page.getByRole("dialog")).toContainText(displayName);
  await page.getByRole("button", { name: "Cancel" }).click();

  // Nothing was sent, so the Invitation is still pending after a fresh listing.
  await expect(pending.filter({ hasText: displayName })).toHaveCount(1);
  await page.reload();
  await expect(pending.filter({ hasText: displayName })).toHaveCount(1);
});

test("the record lists its columns on a wide sheet and stacks them at 360px", async ({ page, audit }) => {
  const displayName = await invited(page);
  await page.getByRole("button", { name: "Done" }).click();

  const record = page.getByRole("table", { name: "Pending Invitations" });
  await expect(record.getByRole("columnheader", { name: "Expires" })).toBeVisible();
  await expect(record.getByRole("row").filter({ hasText: displayName })).toHaveCount(1);

  await page.setViewportSize({ width: 360, height: 740 });
  // The columns stack: each value carries its own term, so the head is dropped.
  await expect(record.getByRole("columnheader", { name: "Expires" })).toBeHidden();
  await expect(record).toContainText(displayName);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
    "the sheet scrolls sideways at 360px",
  ).toBe(false);
  await audit(page);
});
