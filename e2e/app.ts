import type { Page } from "@playwright/test";

/**
 * Driving the app the way a School Administrator does, for the specs that need
 * to arrange something before asserting anything.
 *
 * These are steps, not assertions: nothing here decides whether the app is
 * right. A spec that wants to know what a step produced asks the page itself.
 */

export async function signIn(page: Page, { username, password }: { username: string; password: string }) {
  await page.goto("/sign-in");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

export function schoolsList(page: Page) {
  return page.getByRole("list", { name: "Schools" }).getByRole("listitem");
}

/** The pending Invitations as rows of the record; the head row names no Person. */
export function pendingInvitations(page: Page) {
  return page.getByRole("table", { name: "Pending Invitations" }).getByRole("row");
}

export async function openSchool(page: Page, name: string) {
  await schoolsList(page).getByRole("link", { name }).click();
}

export async function addPerson(page: Page, displayName: string) {
  await page.getByLabel("Display name").fill(displayName);
  await page.getByRole("button", { name: "Add Person" }).click();
}

/**
 * Issues the Person's Invitation, leaving its link on the screen. The link is
 * held in a dialog that only the acknowledgement closes, so a spec that has
 * read it goes on through `acknowledgeIssuedLink`.
 */
export async function issueInvitationFor(page: Page, displayName: string) {
  await page.getByRole("button", { name: `Invite ${displayName}` }).click();
}

export async function acknowledgeIssuedLink(page: Page) {
  await page.getByRole("button", { name: "Done" }).click();
}

export function revokeButtonFor(page: Page, displayName: string) {
  return page.getByRole("button", { name: `Revoke the Invitation for ${displayName}` });
}

/** Revokes the Person's Invitation, through the confirmation that names what that does. */
export async function revokeInvitationFor(page: Page, displayName: string) {
  await revokeButtonFor(page, displayName).click();
  await page.getByRole("button", { name: "Revoke the Invitation", exact: true }).click();
}
