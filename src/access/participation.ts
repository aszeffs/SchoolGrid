import { findClassOffering, lockClassOffering, type DescribedClassOffering } from "../academic-structure/courses.ts";
import type { SchoolDate } from "../calendar/index.ts";
import type { Queryable } from "../db/transaction.ts";
import { InvalidRequest } from "../http/invalid-request.ts";
import { schoolDateFrom } from "../http/request-body.ts";
import { authorizeManageClassOffering, type Actor } from "./index.ts";

/*
 * What Teaching assignments and Roster memberships share as requests: each is
 * a Person's participation in a Class Offering, bounded by School dates inside
 * its Term (ADR-0011), and made, moved and ended the same way.
 */

/** The bounds of a participation: an open one has no last date, and runs to the end of its Term. */
export interface Bounds {
  firstDate: SchoolDate;
  lastDate: SchoolDate | null;
}

// Validation below runs only once the Access decision has permitted the
// caller: see InvalidRequest.

/** A last date: absent when not stated, null for an open participation, or a School date. */
export function lastDateFrom(fields: Record<string, unknown>): SchoolDate | null | undefined {
  const value = fields["lastDate"];
  return value === undefined || value === null ? value : schoolDateFrom(value, "lastDate");
}

/** A first date: absent when not stated, or a School date. */
export function firstDateFrom(fields: Record<string, unknown>): SchoolDate | undefined {
  return fields["firstDate"] === undefined ? undefined : schoolDateFrom(fields["firstDate"], "firstDate");
}

/** Refuses bounds out of order. */
export function checkInOrder({ firstDate, lastDate }: Bounds): void {
  if (lastDate !== null && lastDate < firstDate) {
    throw new InvalidRequest("lastDate must not be before firstDate");
  }
}

/**
 * Refuses bounds reaching beyond a participation's own, for one whose Person no
 * longer holds what it requires: it can still be corrected or shortened, as a
 * record of what they took part in, but not made to reach further. `because`
 * finishes the sentence saying why.
 */
export function checkNotExtended(bounds: Bounds, held: Bounds, termLastDate: SchoolDate, because: string): void {
  if (bounds.firstDate < held.firstDate || (bounds.lastDate ?? termLastDate) > (held.lastDate ?? termLastDate)) {
    throw new InvalidRequest(`it may not be extended, as ${because}`);
  }
}

/*
 * Each record the actor may act on is found, decided, and only then locked:
 * see lockMembership. One deleted between the two is decided again as the
 * absent record it now is, so the caller is refused as for any other.
 */

/** The Class Offering the actor may add participation to, locked for the rest of the transaction. */
export async function lockPermittedOffering(
  transaction: Queryable,
  actor: Actor,
  classOfferingId: string,
): Promise<DescribedClassOffering> {
  const permitted = authorizeManageClassOffering(
    actor,
    classOfferingId,
    await findClassOffering(transaction, classOfferingId),
  );
  return (
    (await lockClassOffering(transaction, permitted)) ??
    authorizeManageClassOffering<DescribedClassOffering>(actor, classOfferingId, null)
  );
}
