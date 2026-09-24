/**
 * What a conflict names: which rule of the School's records the change would
 * have broken.
 *
 * Imported by `web/` as a type, so a form can say why its change was refused
 * in the same words the service decided it in.
 */
export type ConflictDetail =
  /** An Academic Year would overlap another in its School. */
  | { conflict: "academic_year_overlap" }
  /** Two of an Academic Year's Terms would overlap. */
  | { conflict: "term_overlap" }
  /** An Academic Year's Terms would leave one of its School dates in no Term. */
  | { conflict: "term_gap" }
  /** A Term would begin before its Academic Year or end after it. */
  | { conflict: "term_outside_academic_year" }
  /** An exception to an Academic Year's weekday pattern would fall outside the year. */
  | { conflict: "exception_outside_academic_year" }
  /** An exception would fall on a date that already has one. */
  | { conflict: "exception_date_taken" }
  /**
   * Something depends on what would change or go, and would be stranded. Only
   * its kind is named, never a record the caller could not otherwise read.
   */
  | { conflict: "dependent"; dependent: "term" | "instructional_day_exception" }
  /** The School's timezone is fixed once its first Academic Year exists (ADR-0011). */
  | { conflict: "timezone_fixed" };

/**
 * Thrown by a handler whose caller was authorized and sent a well-formed
 * request that the School's records as they stand cannot take: an Academic
 * Year overlapping another, a deletion that would strand what depends on it.
 * The server-wide error handler answers it 409, naming the conflict.
 *
 * Like InvalidRequest, only ever thrown after the Access decision, and for the
 * same reason: what it names is the caller's to know only once they may act.
 */
export class Conflict extends Error {
  readonly statusCode = 409;

  constructor(readonly detail: ConflictDetail) {
    super(`conflict: ${detail.conflict}`);
  }
}
