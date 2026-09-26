import { randomUUID } from "node:crypto";
import {
  acknowledgeIssuedLink,
  arrangePerson,
  cancelDialog,
  darken,
  issueInvitationFor,
  revokeButtonFor,
  schoolIdOf,
  signIn,
} from "./app.ts";
import { seeded } from "./seeded.ts";
import { expect, test } from "./test.ts";

/**
 * The School Administrator's people pages, held to the same bar in the dark
 * rendition as the rest of the suite holds them to in the light one
 * (ADR-0010), with every confirmation they open.
 */
const PAGES = [
  { path: "account", heading: "Your account" },
  { path: "persons", heading: "Persons" },
  { path: "invitations", heading: "Invitations" },
  { path: "memberships", heading: "School memberships" },
  { path: "enrollments", heading: "Enrollments" },
  { path: "guardian-links", heading: "Guardian links" },
] as const;

test("the people pages and their confirmations stay legible in the dark rendition", async ({ page, audit }) => {
  const { schoolAdministrator, schools, faculty } = seeded();
  await signIn(page, schoolAdministrator);
  await expect(page).not.toHaveURL(/sign-in/);
  const schoolId = await schoolIdOf(page, schools[0]!);
  const invited = `Rowan ${randomUUID().slice(0, 8)}`;
  await arrangePerson(page, schoolId, invited, []);
  await darken(page);

  for (const { path, heading } of PAGES) {
    await page.goto(`/schools/${schoolId}/${path}`);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await audit(page);
  }

  // The Invitation's link, shown once as it is issued, and then its revoke.
  await page.goto(`/schools/${schoolId}/persons`);
  await issueInvitationFor(page, invited);
  await expect(page.getByRole("dialog").getByLabel("Invitation link")).toBeVisible();
  await audit(page);
  await acknowledgeIssuedLink(page);
  await page.goto(`/schools/${schoolId}/invitations`);
  await revokeButtonFor(page, invited).click();
  await audit(page);
  await cancelDialog(page);

  // A Faculty membership's, so each names the teaching it would end; Narrow only once it has a date.
  const facultyMembership = `${faculty.displayName}’s Faculty membership`;
  await page.goto(`/schools/${schoolId}/memberships`);
  await page.getByRole("button", { name: `Narrow ${facultyMembership}` }).click();
  await page.getByRole("dialog").getByLabel("Ends on").fill("2099-06-30");
  await expect(page.getByRole("dialog").getByRole("list")).toBeVisible();
  await audit(page);
  await cancelDialog(page);
  await page.getByRole("button", { name: `Revoke ${facultyMembership}` }).click();
  await expect(page.getByRole("dialog").getByRole("list")).toBeVisible();
  await audit(page);
  await cancelDialog(page);

  for (const path of ["enrollments", "guardian-links"]) {
    await page.goto(`/schools/${schoolId}/${path}`);
    await page.getByRole("main").getByRole("button", { name: /^End / }).first().click();
    await audit(page);
    await cancelDialog(page);
  }
});
