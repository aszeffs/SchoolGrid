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

test("signing in shows the Schools the account reaches, survives a refresh, and signing out ends it", async ({
  page,
  context,
}) => {
  const { schoolAdministrator, schools } = seeded();

  // Not yet signed in, the app sends them to sign in.
  await page.goto("/");
  await expect(page).toHaveURL("/sign-in");

  await signIn(page, schoolAdministrator);
  await expect(page).toHaveURL("/");
  await expect(schoolsList(page)).toHaveText(schools, { useInnerText: true });

  await page.reload();
  await expect(schoolsList(page)).toHaveText(schools, { useInnerText: true });

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/sign-in");
  expect((await context.cookies()).map(({ name }) => name)).not.toContain(SESSION_COOKIE);
  await page.goto("/");
  await expect(page).toHaveURL("/sign-in");
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

  await page.goto("/schools/no-such-school/persons");
  await expect(page.getByRole("heading", { name: "Not available" })).toBeVisible();
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
