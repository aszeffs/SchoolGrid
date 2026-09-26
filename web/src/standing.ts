import type { ListedPerson, Membership, Role } from "./api.ts";

/**
 * What the Roles, Enrollments and Guardians sheets each read off the records
 * the server sent, so the three cannot come to disagree about it.
 *
 * None of it is a decision. Which Person may be enrolled or linked is the
 * server's to say; this only keeps a form from offering a choice the server is
 * certain to refuse, and a refusal still shows the one "not available" state.
 */

/** Each Person's display name, by id, for records that name Persons only by id. */
export function namesOf(persons: readonly ListedPerson[]): (personId: string) => string {
  const names = new Map(persons.map((person) => [person.id, person.displayName]));
  // A Person the School holds is always listed to its School Administrator;
  // the fallback is for a record read a moment before the Person was.
  return (personId) => names.get(personId) ?? "A Person";
}

/** Whether a membership is over: its end has passed, or it was revoked before it began. */
export function hasEnded({ startsAt, endsAt }: Membership, now: Date): boolean {
  return endsAt !== null && (new Date(endsAt) <= now || new Date(endsAt) <= new Date(startsAt));
}

/** The Persons holding this role now, or from a start still to come. */
export function holdingNowOrLater(memberships: readonly Membership[], role: Role, now: Date): Set<string> {
  return new Set(
    memberships
      .filter((membership) => membership.role === role && !hasEnded(membership, now))
      .map((membership) => membership.personId),
  );
}

/** Orders records by the name of the Person each is about, as a reader looks one up. */
export function byName<T>(nameOf: (row: T) => string): (a: T, b: T) => number {
  return (a, b) => nameOf(a).localeCompare(nameOf(b));
}

/** A moment as a reader expects it: a date, and a time of day. */
export const MOMENT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A day as a reader expects it. */
export const DAY = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** The day after this moment's, in the reader's own time zone, as a date field writes it. */
export function dayAfter(moment: Date): string {
  const next = new Date(moment);
  next.setHours(0, 0, 0, 0);
  next.setDate(next.getDate() + 1);
  return dayOf(next);
}

/**
 * This moment's day in the reader's own time zone, as a date field writes it.
 * Near enough to the School's date to decide what a page offers; what is
 * recorded is decided by the server, in the School's timezone.
 */
export function dayOf(moment: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(moment.getFullYear(), 4)}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`;
}

/**
 * A School date, written `YYYY-MM-DD`, as a reader expects a day. It is the
 * day the School saw, so it is read as that day wherever the reader is,
 * rather than as a moment their own timezone could move.
 */
export function formatSchoolDate(date: string): string {
  return DAY.format(localDay(date));
}

/** The School date after this one, as a date field writes it. */
export function schoolDateAfter(date: string): string {
  return dayAfter(localDay(date));
}

function localDay(date: string): Date {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  // Not `new Date(year, …)`, which reads years 0 to 99 as 1900 to 1999.
  const local = new Date(0, 0, 1);
  local.setFullYear(year, month - 1, day);
  return local;
}
