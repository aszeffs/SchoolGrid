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

/** The People as rows of the record; the head row names no Person. */
export function peopleRecord(page: Page) {
  return page.getByRole("table", { name: "People" }).getByRole("row");
}

/** The pending Invitations as rows of the record; the head row names no Person. */
export function pendingInvitations(page: Page) {
  return page.getByRole("table", { name: "Pending Invitations" }).getByRole("row");
}

/** Moves to another page within the School the way the navigation offers it. */
export async function openSection(page: Page, label: string) {
  await page.getByRole("navigation").getByRole("link", { name: label }).click();
}

export async function openSchool(page: Page, name: string) {
  await schoolsList(page).getByRole("link", { name }).click();
}

export async function addPerson(page: Page, displayName: string) {
  await page.getByLabel("Display name").fill(displayName);
  await page.getByRole("button", { name: "Add Person" }).click();
}

/**
 * Issues the Person's Invitation from the People sheet, leaving its link on the
 * screen. The link is held in a dialog that only the acknowledgement closes, so
 * a spec that has read it goes on through `acknowledgeIssuedLink`.
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

/**
 * Revokes the Person's Invitation, through the confirmation that names what that
 * does. Revoking is offered on the Invitations sheet, so the page is already
 * there.
 */
export async function revokeInvitationFor(page: Page, displayName: string) {
  await revokeButtonFor(page, displayName).click();
  await page.getByRole("button", { name: "Revoke the Invitation", exact: true }).click();
}
