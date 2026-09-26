import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { acknowledgeIssuedLink, arrangePerson, issueInvitationFor, revokeButtonFor, signIn } from "./app.ts";
import { seeded } from "./seeded.ts";
import { expect, test } from "./test.ts";

/**
 * The School Administrator's people pages, each with the confirmations it
 * opens, held to the same bar in the dark rendition as the rest of the suite
 * holds them to in the light one (ADR-0010).
 */
const PAGES = [
  { path: "account", heading: "Your account", confirms: [] },
  { path: "persons", heading: "Persons", confirms: [] },
  { path: "invitations", heading: "Invitations", confirms: [] },
  { path: "memberships", heading: "School memberships", confirms: [/^Narrow /, /^Revoke /] },
  { path: "enrollments", heading: "Enrollments", confirms: [/^End /] },
  { path: "guardian-links", heading: "Guardian links", confirms: [/^End /] },
];

/** Switches the page to the dark rendition, with motion reduced so nothing is audited mid-fade. */
async function darken(page: Page) {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  // Two frames painted in the dark rendition, so axe reads no text still drawn in the light one.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/** The School the seeded administrator reaches first, where the seeded Student and Guardian are. */
async function firstSchool(page: Page): Promise<string> {
  const { schools } = (await (await page.request.get("/api/session")).json()) as {
    schools: { schoolId: string; name: string }[];
  };
  return schools.find((school) => school.name === seeded().schools[0])!.schoolId;
}

test("the people pages and their confirmations stay legible in the dark rendition", async ({ page, audit }) => {
  await signIn(page, seeded().schoolAdministrator);
  await expect(page).not.toHaveURL(/sign-in/);
  const schoolId = await firstSchool(page);
  const invited = `Rowan ${randomUUID().slice(0, 8)}`;
  await arrangePerson(page, schoolId, invited, []);
  await darken(page);

  for (const { path, heading, confirms } of PAGES) {
    await page.goto(`/schools/${schoolId}/${path}`);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await audit(page);

    for (const name of confirms) {
      await page.getByRole("main").getByRole("button", { name }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await audit(page);
      await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("dialog")).toBeHidden();
    }

    // The Invitation's link, and then its revoke, which only exist once one is issued.
    if (path === "persons") {
      await issueInvitationFor(page, invited);
      await expect(page.getByRole("dialog").getByLabel("Invitation link")).toBeVisible();
      await audit(page);
      await acknowledgeIssuedLink(page);
    }
    if (path === "invitations") {
      await revokeButtonFor(page, invited).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await audit(page);
      await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    }
  }
});
