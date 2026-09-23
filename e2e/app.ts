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

/** The Persons as rows of the record; the head row names no Person. */
export function personsRecord(page: Page) {
  return page.getByRole("table", { name: "Persons" }).getByRole("row");
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
 * Issues the Person's Invitation from the Persons sheet, leaving its link on the
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

/** The id of a School the signed-in account reaches, by its name. */
export async function schoolIdOf(page: Page, name: string): Promise<string> {
  const { schools } = (await (await page.request.get("/api/session")).json()) as {
    schools: { schoolId: string; name: string }[];
  };
  return schools.find((school) => school.name === name)!.schoolId;
}

/**
 * Sends one change to the API as the signed-in account, for a spec to arrange
 * what the sheet under test is not itself for: the Persons, roles and
 * Enrollments a Guardian link needs, say. It carries the page's own origin,
 * as the browser would, and fails the spec when the change is not made.
 */
export async function arrange<T>(
  page: Page,
  schoolId: string,
  path: string,
  data: Record<string, unknown>,
): Promise<T> {
  const response = await page.request.post(`/api/schools/${schoolId}${path}`, {
    headers: { origin: new URL(page.url()).origin },
    data,
  });
  if (!response.ok()) {
    throw new Error(`could not arrange POST ${path}: ${response.status()}`);
  }
  return (await response.json()) as T;
}

/** A Person of the spec's own, holding each of these roles from now. */
export async function arrangePerson(
  page: Page,
  schoolId: string,
  displayName: string,
  roles: string[],
): Promise<string> {
  const { person } = await arrange<{ person: { id: string } }>(page, schoolId, "/persons", { displayName });
  for (const role of roles) {
    await arrange(page, schoolId, "/memberships", { personId: person.id, role });
  }
  return person.id;
}

/** The rows of a record, by the name it is listed under; the head row names nothing. */
export function recordRows(page: Page, label: string) {
  return page.getByRole("table", { name: label, exact: true }).getByRole("row");
}

/**
 * Records every change the page sends to the API from here on, so a spec can
 * say that a cancelled confirmation sent nothing at all, rather than only that
 * the page still looks the same.
 */
export function changesSent(page: Page): string[] {
  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith("/api/schools/")) {
      sent.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  return sent;
}
