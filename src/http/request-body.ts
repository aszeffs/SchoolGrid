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
