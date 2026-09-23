/**
 * The bounds a caller-supplied value is held to, in the one place the service
 * and the web app both read them from.
 *
 * Only the bounds both hold to. One the service alone enforces stays beside
 * the check that enforces it.
 *
 * The web app restates none of them. A form whose `maxLength` drifted from the
 * bound the service enforces would let someone type a value that is refused
 * only once sent, or stop them short of one that would have been accepted.
 * Nothing here decides whether a value is *allowed* — that is the service's
 * alone (see http/request-body.ts); these are the lengths beyond which it is
 * not worth asking.
 *
 * Imported by `web/`, so it holds constants and nothing else: no Node built-in,
 * no database, nothing that cannot be bundled into a page.
 */

/**
 * A short piece of text naming something: a School's name, a Person's display
 * name.
 */
export const MAX_NAME_LENGTH = 200;

/**
 * The reason a change is made for, as written to its Audit record. Ending an
 * Enrollment requires one, and the web app's form for it holds to this.
 */
export const MAX_REASON_LENGTH = 1000;

/**
 * Bounds a malformed sign-in rather than an honest one. Credentials longer
 * than these are refused like any other failed attempt, without being hashed.
 */
export const MAX_USERNAME_LENGTH = 254;
export const MAX_PASSWORD_LENGTH = 1024;
