import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { seeded } from "./seeded.ts";

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

/** Switches the page to the dark rendition, with motion reduced so nothing is audited mid-fade. */
export async function darken(page: Page) {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  // Two frames painted in the dark rendition, so axe reads no text still drawn in the light one.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/** Closes the open dialog without doing what it asks, and waits for it to go. */
export async function cancelDialog(page: Page) {
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
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

/** The Person a seeded account resolves to in this School. */
export async function personIdOf(page: Page, schoolId: string, account: { displayName: string }): Promise<string> {
  const response = await page.request.get(`/api/schools/${schoolId}/persons`);
  const { persons } = (await response.json()) as { persons: { id: string; displayName: string }[] };
  return persons.find((person) => person.displayName === account.displayName)!.id;
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

/** Issues an Invitation to a Person of the spec's own, and returns what redeeming it sends. */
export async function invitationFor(page: Page, schoolId: string, personId: string, username: string) {
  const { link } = await arrange<{ link: string }>(page, schoolId, "/invitations", { personId });
  return { secret: new URL(link).hash.slice(1), username, password: "a Person's own staple, long enough" };
}

/** Redeems an Invitation through this client, which is left signed in as the new account. */
export async function redeem(client: APIRequestContext, origin: string, redemption: Record<string, string>) {
  const redeemed = await client.post("/api/invitations/redeem", { headers: { origin }, data: redemption });
  if (redeemed.status() !== 201) {
    throw new Error(`could not redeem the Invitation for ${redemption["username"]}: ${redeemed.status()}`);
  }
}

/** A year far enough ahead that no other spec's can overlap it. */
export function yearAhead(): { firstDate: string; lastDate: string } {
  const starts = 2100 + Math.floor(Math.random() * 7000);
  return { firstDate: `${starts}-09-01`, lastDate: `${starts + 1}-06-30` };
}

/** A Term of the spec's own, its dates as `YYYY-MM-DD`, and its name alone and as the Term picker offers it. */
export interface OwnTerm {
  id: string;
  name: string;
  option: string;
  firstDate: string;
  lastDate: string;
}

/**
 * A School Administrator signed in to the first seeded School, with an
 * Academic Year of the spec's own over these dates, a year ahead unless the
 * spec says otherwise, made one Term.
 */
export async function withOwnTerm(page: Page, dates = yearAhead()): Promise<{ schoolId: string; term: OwnTerm }> {
  const { schoolAdministrator, schools } = seeded();
  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[0]!);
  const schoolId = await schoolIdOf(page, schools[0]!);
  const yearName = `Year ${randomUUID().slice(0, 8)}`;
  const { academicYear } = await arrange<{ academicYear: { id: string } }>(page, schoolId, "/academic-years", {
    name: yearName,
    ...dates,
  });
  const name = "Whole year";
  const divided = await page.request.patch(`/api/schools/${schoolId}/academic-years/${academicYear.id}`, {
    headers: { origin: new URL(page.url()).origin },
    data: { terms: [{ name, ...dates }] },
  });
  if (!divided.ok()) {
    throw new Error(`could not arrange the Terms of ${yearName}: ${divided.status()}`);
  }
  const { academicYear: year } = (await divided.json()) as { academicYear: { terms: { id: string }[] } };
  return { schoolId, term: { id: year.terms[0]!.id, name, option: `${name}, ${yearName}`, ...dates } };
}

/**
 * The Attendance specs' Class Offering: a School Administrator signed in to
 * the third seeded School, the Attendance specs' own, with a Course of the
 * spec's own offered in the Term around today there. That Term is made by
 * whichever spec asks first and shared by the rest, since years cannot
 * overlap: its year has every day of the week an Instructional day, so today
 * can be taken whatever day the suite runs.
 */
export async function withAttendanceOffering(
  page: Page,
): Promise<{ schoolId: string; classOfferingId: string; courseName: string; token: string; term: { firstDate: string; lastDate: string } }> {
  const { schoolAdministrator, schools } = seeded();
  await signIn(page, schoolAdministrator);
  await openSchool(page, schools[2]!);
  const schoolId = await schoolIdOf(page, schools[2]!);
  const token = randomUUID().slice(0, 8);
  const term = await termAroundToday(page, schoolId);
  const courseName = `Algebra ${token}`;
  const { course } = await arrange<{ course: { id: string } }>(page, schoolId, "/courses", { name: courseName });
  const { classOffering } = await arrange<{ classOffering: { id: string } }>(page, schoolId, "/class-offerings", {
    courseId: course.id,
    termId: term.id,
  });
  return { schoolId, classOfferingId: classOffering.id, courseName, token, term };
}

/** The Term running today in this School, made with its year from thirty days ago to thirty on when there is none. */
async function termAroundToday(page: Page, schoolId: string): Promise<{ id: string; firstDate: string; lastDate: string }> {
  type Term = { id: string; firstDate: string; lastDate: string };
  const listed = await page.request.get(`/api/schools/${schoolId}/academic-years`);
  const { academicYears } = (await listed.json()) as { academicYears: { terms: Term[] }[] };
  const today = new Date().toISOString().slice(0, 10);
  const held = academicYears.flatMap((year) => year.terms).find((term) => term.firstDate <= today && today <= term.lastDate);
  if (held !== undefined) {
    return held;
  }
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const dates = { firstDate: day(-30), lastDate: day(30) };
  const { academicYear } = await arrange<{ academicYear: { id: string } }>(page, schoolId, "/academic-years", {
    name: `Year ${randomUUID().slice(0, 8)}`,
    ...dates,
    weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
  });
  const divided = await page.request.patch(`/api/schools/${schoolId}/academic-years/${academicYear.id}`, {
    headers: { origin: new URL(page.url()).origin },
    data: { terms: [{ name: "Whole year", ...dates }] },
  });
  if (!divided.ok()) {
    throw new Error(`could not arrange the Term around today: ${divided.status()}`);
  }
  const { academicYear: year } = (await divided.json()) as { academicYear: { terms: Term[] } };
  return year.terms[0]!;
}

/** A Class Offering of the spec's own: see withOwnTerm. */
export interface OwnOffering {
  schoolId: string;
  classOfferingId: string;
  courseId: string;
  /** The offering as its page is headed: its Course and label. */
  offering: string;
  term: OwnTerm;
}

/** A School Administrator in the first School, with a Class Offering of the spec's own in a Term of its own: see withOwnTerm. */
export async function withOwnOffering(page: Page, dates = yearAhead()): Promise<OwnOffering> {
  const { schoolId, term } = await withOwnTerm(page, dates);
  const courseName = `Course ${randomUUID().slice(0, 8)}`;
  const { course } = await arrange<{ course: { id: string } }>(page, schoolId, "/courses", { name: courseName });
  const { classOffering } = await arrange<{ classOffering: { id: string } }>(page, schoolId, "/class-offerings", {
    courseId: course.id,
    termId: term.id,
    label: "Section A",
  });
  return {
    schoolId,
    classOfferingId: classOffering.id,
    courseId: course.id,
    offering: `${courseName}, Section A`,
    term,
  };
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

/** One page of a School's trail, as the API answers it. */
export interface TrailPage {
  auditRecords: unknown[];
  nextCursor: string | null;
}

/**
 * Answers the trail from `pages` by the cursor asked for (`first` for none), so
 * paging is asserted against pages of a known length. The server's own bound
 * and ordering are the API suite's to assert. Returns every cursor asked for.
 */
export async function stubTrail(page: Page, pages: Record<string, TrailPage>): Promise<string[]> {
  const asked: string[] = [];
  await page.route("**/api/schools/*/audit-records*", (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    asked.push(cursor ?? "first");
    return route.fulfill({ status: 200, json: pages[cursor ?? "first"] });
  });
  return asked;
}
