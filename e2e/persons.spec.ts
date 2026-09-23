import { randomUUID } from "node:crypto";
import { addPerson, openSchool, openSection, personsRecord, signIn } from "./app.ts";
import { seeded } from "./seeded.ts";
import { expect, expectNoSidewaysScroll, test } from "./test.ts";

/**
 * Persons: every Person in one School that the actor may read, the way to add
 * one, and the way to find one among them.
 *
 * The navigation lists the sheet as People; the sheet names itself Persons,
 * after the glossary's term.
 *
 * What a Person is and what claiming one means are asserted at the HTTP seam.
 * What is asserted here is what the sheet shows, to whom, and at what width.
 */

test("a School Administrator adds a Person, who is listed unclaimed in that School alone", async ({
  page,
  audit,
}) => {
  const { schoolAdministrator, schools } = seeded();
  const displayName = `Riley ${randomUUID().slice(0, 8)}`;

  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[0]!);
  await expect(page.getByRole("heading", { level: 1, name: "Persons" })).toBeVisible();

  await addPerson(page, displayName);

  const added = personsRecord(page).filter({ hasText: displayName });
  await expect(added.getByRole("cell")).toHaveText([displayName, "Unclaimed", "Invite"]);
  await expect(page.getByLabel("Display name")).toHaveValue("");
  await audit(page);

  // A refresh lists them from the API, not from what the page remembered.
  await page.reload();
  await expect(added.getByRole("cell")).toHaveText([displayName, "Unclaimed", "Invite"]);

  // The Person is in the School that was chosen, and no other.
  await page.goto("/");
  await openSchool(page, schools[1]!);
  await expect(page.getByRole("heading", { level: 1, name: "Persons" })).toBeVisible();
  await expect(personsRecord(page).filter({ hasText: displayName })).toHaveCount(0);
});

test("the Persons are narrowed by name on the sheet itself, and say what was found", async ({ page }) => {
  const { schoolAdministrator, schools } = seeded();
  const suffix = randomUUID().slice(0, 8);
  const looked = `Wanted ${suffix}`;
  const other = `Bystander ${suffix}`;

  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[0]!);
  // Each is waited for before the next is typed. The form is cleared once the
  // server has answered, so a second name filled in before that lands is wiped
  // by the clearing and never sent.
  await addPerson(page, looked);
  await expect(personsRecord(page).filter({ hasText: looked })).toHaveCount(1);
  await addPerson(page, other);
  await expect(personsRecord(page).filter({ hasText: other })).toHaveCount(1);

  // Nothing is asked of the server: every request the field could have made is
  // failed, and the record still narrows.
  await page.route("**/api/schools/*/persons", (route) => route.abort());
  const find = page.getByLabel("Find by name");
  await find.fill(looked);

  await expect(personsRecord(page).filter({ hasText: looked })).toHaveCount(1);
  await expect(personsRecord(page).filter({ hasText: other })).toHaveCount(0);
  // Matched by any part of the name, whatever the case it was typed in.
  await find.fill(suffix.toUpperCase());
  await expect(personsRecord(page).filter({ hasText: looked })).toHaveCount(1);
  await expect(personsRecord(page).filter({ hasText: other })).toHaveCount(1);
  await expect(page.getByRole("status")).toContainText("2 of");

  // A name that matches nobody says so, rather than showing a bare sheet.
  await find.fill(`no Person is called this ${suffix}`);
  await expect(personsRecord(page)).toHaveCount(0);
  await expect(page.getByRole("main")).toContainText(`No Person's name contains`);
});

test("a School with no Person yet says so and offers the first action", async ({ page, audit }) => {
  const { schoolAdministrator, schools } = seeded();
  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[0]!);
  await expect(page.getByRole("heading", { level: 1, name: "Persons" })).toBeVisible();

  // A brand-new School, which no seeded School is: the listing is emptied so the
  // state a School Administrator meets on their first day can be asserted.
  await page.route("**/api/schools/*/persons", (route) =>
    route.request().method() === "GET" ? route.fulfill({ status: 200, json: { persons: [] } }) : route.fallback(),
  );
  await page.reload();

  await expect(page.getByRole("main")).toContainText("No Person is recorded in this School yet");
  // The first action is on the sheet, not somewhere else.
  await expect(page.getByRole("button", { name: "Add Person" })).toBeVisible();
  // With nobody to find, no field to find them with.
  await expect(page.getByLabel("Find by name")).toHaveCount(0);
  await audit(page);
});

test("a role that is not a School Administrator is shown names and nothing about claiming", async ({
  page,
  audit,
}) => {
  await signIn(page, seeded().faculty);
  await expect(page.getByRole("heading", { level: 1, name: "Your account" })).toBeVisible();
  await openSection(page, "People");

  await expect(page.getByRole("heading", { level: 1, name: "Persons" })).toBeVisible();
  const rows = personsRecord(page);
  await expect(rows).not.toHaveCount(0);
  // One column and no other: neither state nor an action is on this rendition.
  await expect(rows.first().getByRole("columnheader")).toHaveText(["Person"]);
  await expect(page.getByRole("main")).not.toContainText("Unclaimed");
  await expect(page.getByRole("main")).not.toContainText("Claimed");
  await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
  // Nor is the way to add one, which the server would refuse anyway.
  await expect(page.getByLabel("Display name")).toHaveCount(0);
  await audit(page);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("a Person's record is read down rather than scrolled across", async ({ page, audit }) => {
    const { schoolAdministrator, schools } = seeded();
    const displayName = `Sam ${randomUUID().slice(0, 8)}`;

    await signIn(page, schoolAdministrator);
    await openSchool(page, schools[0]!);
    await addPerson(page, displayName);

    const added = personsRecord(page).filter({ hasText: displayName });
    await expect(added).toHaveCount(1);
    // The columns stack, so each value carries its own term and the head is dropped.
    await expect(page.getByRole("columnheader", { name: "Person" })).toBeHidden();
    await expect(added).toContainText("Unclaimed");
    await expectNoSidewaysScroll(page);
    await audit(page);
  });
});
