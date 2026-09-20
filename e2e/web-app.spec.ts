import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { seeded } from "./seeded.ts";
import { expect, test } from "./test.ts";

const SESSION_COOKIE = "__Host-session";

async function signIn(page: Page, { username, password }: { username: string; password: string }) {
  await page.goto("/sign-in");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

function schoolsList(page: Page) {
  return page.getByRole("list", { name: "Schools" }).getByRole("listitem");
}

/** The pending Invitations as rows of the record; the head row names no Person. */
function pendingInvitations(page: Page) {
  return page.getByRole("table", { name: "Pending Invitations" }).getByRole("row");
}

/** Revokes the named Person's Invitation, through the confirmation that names what that does. */
async function revokeInvitationFor(page: Page, displayName: string) {
  await page.getByRole("button", { name: `Revoke the Invitation for ${displayName}` }).click();
  await page.getByRole("button", { name: "Revoke the Invitation", exact: true }).click();
}

test("signing in shows the Schools the account reaches, survives a refresh, and signing out ends it", async ({
  page,
  context,
  audit,
}) => {
  const { schoolAdministrator, schools } = seeded();

  // Not yet signed in, the app sends them to sign in.
  await page.goto("/");
  await expect(page).toHaveURL("/sign-in");
  await audit(page);

  await signIn(page, schoolAdministrator);
  await expect(page).toHaveURL("/");
  await expect(schoolsList(page)).toHaveText(schools, { useInnerText: true });
  await audit(page);

  await page.reload();
  await expect(schoolsList(page)).toHaveText(schools, { useInnerText: true });

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/sign-in");
  expect((await context.cookies()).map(({ name }) => name)).not.toContain(SESSION_COOKIE);
  await page.goto("/");
  await expect(page).toHaveURL("/sign-in");
});

test("a sign-out that did not work shows the page is not available", async ({
  page,
  context,
}) => {
  await signIn(page, seeded().schoolAdministrator);
  await expect(schoolsList(page)).not.toHaveCount(0);

  await page.route("**/api/session", (route) =>
    route.request().method() === "DELETE" ? route.fulfill({ status: 503 }) : route.fallback(),
  );
  await page.getByRole("button", { name: "Sign out" }).click();

  await expect(page.getByRole("heading", { name: "Not available" })).toBeVisible();
  expect((await context.cookies()).map(({ name }) => name)).toContain(SESSION_COOKIE);
});

test("the session is held where page script cannot read it", async ({ page, context }) => {
  await signIn(page, seeded().schoolAdministrator);
  await expect(schoolsList(page)).not.toHaveCount(0);

  // The browser does hold a session, so the assertion below is not vacuous.
  expect(await context.cookies()).toContainEqual(
    expect.objectContaining({ name: SESSION_COOKIE, httpOnly: true, secure: true, sameSite: "Strict" }),
  );
  expect(await page.evaluate(() => document.cookie)).toBe("");
});

test("a failed sign-in shows one generic message, whatever the cause", async ({ page }) => {
  const { schoolAdministrator } = seeded();
  const causes = [
    { username: "nobody-by-this-name", password: "whatever it is" },
    { username: schoolAdministrator.username, password: "not the password" },
    { username: schoolAdministrator.username, password: "x".repeat(2000) },
  ];

  const messages: string[] = [];
  for (const credentials of causes) {
    await signIn(page, credentials);
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    messages.push(await alert.innerText());
    await expect(page).toHaveURL("/sign-in");
  }

  expect(new Set(messages).size).toBe(1);
});

test("a deep link opens the app at that page", async ({ page }) => {
  await page.goto("/sign-in?from=a-bookmark");
  await expect(page.getByRole("heading", { name: "Sign in to SchoolGrid" })).toBeVisible();

  await signIn(page, seeded().schoolAdministrator);
  await expect(schoolsList(page)).not.toHaveCount(0);
  const { schools } = (await (await page.request.get("/api/schools")).json()) as {
    schools: { id: string }[];
  };

  await page.goto(`/schools/${schools[0]!.id}/persons`);
  await expect(page.getByRole("heading", { name: "Persons" })).toBeVisible();

  await page.goto("/schools/no-such-school/persons");
  await expect(page.getByRole("heading", { name: "Not available" })).toBeVisible();
  await page.goto("/no/such/page");
  await expect(page.getByRole("heading", { name: "Not available" })).toBeVisible();
});

test("a School Administrator adds a Person, who is listed unclaimed", async ({ page }) => {
  const { schoolAdministrator, schools } = seeded();
  const displayName = `Riley ${randomUUID().slice(0, 8)}`;

  await signIn(page, schoolAdministrator);
  await schoolsList(page).getByRole("link", { name: schools[0]! }).click();
  await expect(page.getByRole("heading", { name: "Persons" })).toBeVisible();

  await page.getByLabel("Display name").fill(displayName);
  await page.getByRole("button", { name: "Add Person" }).click();

  const persons = page.getByRole("list", { name: "Persons" }).getByRole("listitem");
  await expect(persons.filter({ hasText: displayName })).toHaveText(`${displayName}UnclaimedInvite`);
  await expect(page.getByLabel("Display name")).toHaveValue("");

  // A refresh lists them from the API, not from what the page remembered.
  await page.reload();
  await expect(persons.filter({ hasText: displayName })).toHaveText(`${displayName}UnclaimedInvite`);
  // The Person is in the School that was chosen, and no other.
  await page.goto("/");
  await schoolsList(page).getByRole("link", { name: schools[1]! }).click();
  await expect(page.getByRole("heading", { name: "Persons" })).toBeVisible();
  await expect(persons.filter({ hasText: displayName })).toHaveCount(0);
});

test("a School Administrator invites an unclaimed Person, copies the link once, and revokes it", async ({
  page,
  context,
  baseURL,
  audit,
}) => {
  const { schoolAdministrator, schools } = seeded();
  const displayName = `Casey ${randomUUID().slice(0, 8)}`;
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await signIn(page, schoolAdministrator);
  await schoolsList(page).getByRole("link", { name: schools[0]! }).click();
  await page.getByLabel("Display name").fill(displayName);
  await page.getByRole("button", { name: "Add Person" }).click();
  await page.getByRole("button", { name: `Invite ${displayName}` }).click();

  const link = page.getByLabel("Invitation link");
  await expect(link).toHaveValue(new RegExp(`^${new URL(baseURL!).origin}/invitation#[A-Za-z0-9_-]{43}$`));
  const issuedLink = await link.inputValue();
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByRole("status")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(issuedLink);

  // The link is held in a dialog, and the dialog is held to the same bar.
  await audit(page);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByLabel("Invitation link")).toHaveCount(0);

  const pending = pendingInvitations(page);
  await expect(pending.filter({ hasText: displayName })).toHaveCount(1);

  // Once the page is left, the link is gone for good; the Invitation is still pending.
  await page.reload();
  await expect(pending.filter({ hasText: displayName })).toHaveCount(1);
  await expect(page.getByLabel("Invitation link")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(issuedLink);

  await revokeInvitationFor(page, displayName);
  await expect(pending.filter({ hasText: displayName })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Pending Invitations" })).toBeVisible();
  await expect(pending.filter({ hasText: displayName })).toHaveCount(0);
});

test("an invited Person redeems the link with a new account and lands signed in", async ({
  page,
  context,
  audit,
}) => {
  const { schoolAdministrator, schools } = seeded();
  const displayName = `Jordan ${randomUUID().slice(0, 8)}`;
  const credentials = {
    username: `jordan-${randomUUID().slice(0, 8)}`,
    password: "a brand new staple, plenty long",
  };

  await signIn(page, schoolAdministrator);
  await schoolsList(page).getByRole("link", { name: schools[0]! }).click();
  await page.getByLabel("Display name").fill(displayName);
  await page.getByRole("button", { name: "Add Person" }).click();
  await page.getByRole("button", { name: `Invite ${displayName}` }).click();
  const link = await page.getByLabel("Invitation link").inputValue();

  // The human behind the Invitation, in a fresh browser context: nothing here
  // shares a cookie or any other state with the administrator's page.
  const invitee = await context.browser()!.newContext();
  try {
    const inviteePage = await invitee.newPage();
    await inviteePage.goto(link);

    await expect(inviteePage.getByRole("heading", { name: `Join ${schools[0]!}` })).toBeVisible();
    await expect(inviteePage.getByText(displayName)).toBeVisible();
    // The invitee's own page, which no other test ends on.
    await audit(inviteePage);
    // Nothing else about the School or Person is on the page.
    for (const other of schools.slice(1)) {
      await expect(inviteePage.locator("body")).not.toContainText(other);
    }

    await inviteePage.getByLabel("Username").fill(credentials.username);
    await inviteePage.getByLabel("Password").fill(credentials.password);
    await inviteePage.getByRole("button", { name: "Redeem Invitation" }).click();

    await expect(inviteePage).toHaveURL("/");
    await expect(inviteePage.getByText(`Signed in as ${credentials.username}`)).toBeVisible();
  } finally {
    await invitee.close();
  }
});

/** Signed in as the School Administrator, adds a Person to a School and returns their Invitation link. */
async function inviteNewPerson(page: Page, school: string, displayName: string): Promise<string> {
  await page.goto("/");
  await schoolsList(page).getByRole("link", { name: school }).click();
  await page.getByLabel("Display name").fill(displayName);
  await page.getByRole("button", { name: "Add Person" }).click();
  await page.getByRole("button", { name: `Invite ${displayName}` }).click();
  const link = await page.getByLabel("Invitation link").inputValue();
  await page.getByRole("button", { name: "Done" }).click();
  return link;
}

async function redeemWithExistingAccount(page: Page, { username, password }: { username: string; password: string }) {
  await page.getByRole("button", { name: "I already have an account" }).click();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in and redeem" }).click();
}

test("a person with an account at one School redeems an Invitation into a second by signing in", async ({
  page,
  context,
}) => {
  const { schoolAdministrator, schools } = seeded();
  const suffix = randomUUID().slice(0, 8);
  const credentials = { username: `morgan-${suffix}`, password: "a staple that reaches two Schools" };

  await signIn(page, schoolAdministrator);
  await expect(schoolsList(page)).not.toHaveCount(0);
  const first = await inviteNewPerson(page, schools[0]!, `Morgan ${suffix}`);
  const second = await inviteNewPerson(page, schools[1]!, `Morgan at ${schools[1]!} ${suffix}`);

  const invitee = await context.browser()!.newContext();
  try {
    const inviteePage = await invitee.newPage();
    await inviteePage.goto(first);
    await inviteePage.getByLabel("Username").fill(credentials.username);
    await inviteePage.getByLabel("Password").fill(credentials.password);
    await inviteePage.getByRole("button", { name: "Redeem Invitation" }).click();
    await expect(inviteePage).toHaveURL("/");
    await inviteePage.getByRole("button", { name: "Sign out" }).click();
    await expect(inviteePage).toHaveURL("/sign-in");

    await inviteePage.goto(second);
    await expect(inviteePage.getByRole("heading", { name: `Join ${schools[1]!}` })).toBeVisible();
    await redeemWithExistingAccount(inviteePage, credentials);

    await expect(inviteePage).toHaveURL("/");
    await expect(inviteePage.getByText(`Signed in as ${credentials.username}`)).toBeVisible();
  } finally {
    await invitee.close();
  }

  // Both Persons are now claimed, each in its own School.
  for (const [school, displayName] of [
    [schools[0]!, `Morgan ${suffix}`],
    [schools[1]!, `Morgan at ${schools[1]!} ${suffix}`],
  ] as const) {
    await page.goto("/");
    await schoolsList(page).getByRole("link", { name: school }).click();
    const persons = page.getByRole("list", { name: "Persons" }).getByRole("listitem");
    await expect(persons.filter({ hasText: displayName })).toHaveCount(1);
    await expect(persons.filter({ hasText: displayName })).not.toContainText("Unclaimed");
  }
});

test("an account that already has a Person in the School sees the generic state, and the link still works", async ({
  page,
  context,
}) => {
  const { schoolAdministrator, schools } = seeded();
  const suffix = randomUUID().slice(0, 8);

  await signIn(page, schoolAdministrator);
  await expect(schoolsList(page)).not.toHaveCount(0);
  const link = await inviteNewPerson(page, schools[0]!, `Taylor ${suffix}`);

  const duplicate = await context.browser()!.newContext();
  try {
    const duplicatePage = await duplicate.newPage();
    await duplicatePage.goto(link);
    // The School Administrator already resolves to a Person in every seeded School.
    await redeemWithExistingAccount(duplicatePage, schoolAdministrator);
    await expect(duplicatePage.getByRole("heading", { name: "Not available" })).toBeVisible();
  } finally {
    await duplicate.close();
  }

  const invitee = await context.browser()!.newContext();
  try {
    const inviteePage = await invitee.newPage();
    await inviteePage.goto(link);
    await expect(inviteePage.getByRole("heading", { name: `Join ${schools[0]!}` })).toBeVisible();
    const username = `taylor-${suffix}`;
    await inviteePage.getByLabel("Username").fill(username);
    await inviteePage.getByLabel("Password").fill("the link still worked for me");
    await inviteePage.getByRole("button", { name: "Redeem Invitation" }).click();
    await expect(inviteePage.getByText(`Signed in as ${username}`)).toBeVisible();
  } finally {
    await invitee.close();
  }
});

test("a stale Invitation link shows the one generic state", async ({ page, context }) => {
  const { schoolAdministrator, schools } = seeded();
  const displayName = `Riley ${randomUUID().slice(0, 8)}`;

  await signIn(page, schoolAdministrator);
  await schoolsList(page).getByRole("link", { name: schools[0]! }).click();
  await page.getByLabel("Display name").fill(displayName);
  await page.getByRole("button", { name: "Add Person" }).click();
  await page.getByRole("button", { name: `Invite ${displayName}` }).click();
  const link = await page.getByLabel("Invitation link").inputValue();
  await page.getByRole("button", { name: "Done" }).click();
  await revokeInvitationFor(page, displayName);

  const stale = await context.browser()!.newContext();
  try {
    const stalePage = await stale.newPage();
    await stalePage.goto(link);
    await expect(stalePage.getByRole("heading", { name: "Not available" })).toBeVisible();

    await stalePage.goto("/invitation#this-secret-was-never-issued-at-all");
    await expect(stalePage.getByRole("heading", { name: "Not available" })).toBeVisible();
  } finally {
    await stale.close();
  }
});

test("a cross-origin form post to a mutating endpoint is refused", async ({ page, baseURL }) => {
  await signIn(page, seeded().schoolAdministrator);
  await expect(schoolsList(page)).not.toHaveCount(0);
  const { schools } = (await (await page.request.get("/api/schools")).json()) as {
    schools: { id: string }[];
  };
  const endpoint = new URL(`/api/schools/${schools[0]!.id}/memberships`, baseURL).href;

  // Sent with the session from SchoolGrid's own origin, the same request
  // reaches the handler, which rejects the empty body. So the refusal below
  // comes from the request crossing sites, not from the endpoint.
  const sameOrigin = await page.request.post(endpoint, { headers: { origin: new URL(baseURL!).origin } });
  expect(await sameOrigin.json()).toEqual({ status: "invalid_request" });

  // Another site's page posts a form to SchoolGrid while the browser is signed
  // in there. SameSite=Strict keeps the cookie off the request, so it is
  // refused as carrying no session. The Origin check is the second defence
  // behind that one; a browser cannot be made to reach it, so it is asserted
  // at the HTTP seam (tests/browser-sessions.test.ts).
  await page.route("http://attacker.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><form method="post" action="${endpoint}"><input name="role" value="school-administrator"><button>Go</button></form>`,
    }),
  );
  await page.goto("http://attacker.test/");
  const [response] = await Promise.all([
    page.waitForResponse(endpoint),
    page.getByRole("button", { name: "Go" }).click(),
  ]);

  expect(response.status()).toBe(404);
  expect(await response.json()).toEqual({ status: "refused" });
});
