import { isKnownTimezone } from "../calendar/index.ts";
import type { Queryable } from "../db/transaction.ts";
import { MAX_NAME_LENGTH, MAX_REASON_LENGTH } from "../validation/bounds.ts";
import { InvalidRequest } from "./invalid-request.ts";

/**
 * Reading a School-scoped request's body. Everything here throws
 * InvalidRequest, so it runs only once the Access decision has permitted the
 * caller: see InvalidRequest.
 */

/** The body's fields, refusing a body that is not an object or names a field not allowed. */
export function fieldsOf(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidRequest("the body must be a JSON object");
  }
  const unexpected = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new InvalidRequest(`unexpected fields: ${unexpected.join(", ")}`);
  }
  return body as Record<string, unknown>;
}

/** The optional reason a change is made for, as written to its Audit record. */
export function reasonFrom(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REASON_LENGTH) {
    throw new InvalidRequest(`reason must be text of at most ${MAX_REASON_LENGTH} characters`);
  }
  return value;
}

/** The reason from a body carrying nothing else, or no body at all. */
export function reasonOnly(body: unknown): string | null {
  return reasonFrom(body === undefined ? undefined : fieldsOf(body, ["reason"])["reason"]);
}

/**
 * A short piece of text naming something, such as a School's name or a
 * Person's display name: not blank, and within the one bound every such name
 * shares.
 */
export function boundedText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_NAME_LENGTH) {
    throw new InvalidRequest(`${field} must be text of at most ${MAX_NAME_LENGTH} characters`);
  }
  return value;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * An instant, written as an ISO 8601 timestamp with its offset. One without an
 * offset is refused rather than read in some timezone: which instant it names
 * would depend on where it was read.
 */
export function instantFrom(value: unknown, field: string): Date {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value) || !isCalendarDate(value.slice(0, 10))) {
    throw new InvalidRequest(`${field} must be an ISO 8601 timestamp`);
  }
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new InvalidRequest(`${field} must be an ISO 8601 timestamp`);
  }
  return instant;
}

/**
 * Whether `YYYY-MM-DD` names a day the calendar has. `Date.parse` does not
 * say: it reads 30 February as 2 March.
 */
function isCalendarDate(date: string): boolean {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

/** Longer than any identifier the database knows, and short enough not to be worth asking about. */
const MAX_TIMEZONE_LENGTH = 64;

/**
 * A timezone a School may have, from a request: an IANA identifier the
 * database knows, spelt exactly as it spells it. The one reading here that
 * has to ask the database.
 */
export async function timezoneFrom(database: Queryable, value: unknown): Promise<string> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TIMEZONE_LENGTH ||
    !(await isKnownTimezone(database, value))
  ) {
    throw new InvalidRequest("timezone must be an IANA timezone identifier the database knows");
  }
  return value;
}
