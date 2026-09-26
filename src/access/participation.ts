import { withConstraintsNamed } from "../academic-structure/constraints.ts";
import { appendAuditRecord, type AuditValues } from "../audit/index.ts";
import { schoolDateAt, type SchoolDate } from "../calendar/index.ts";
import { transactionTime, type Queryable } from "../db/transaction.ts";
import type { ConflictDetail } from "../http/conflict.ts";
import { InvalidRequest } from "../http/invalid-request.ts";
import { fieldsOf, reasonFrom, schoolDateFrom } from "../http/request-body.ts";
import type { Person } from "../identity/index.ts";
import type { Actor } from "./index.ts";

/*
 * What Teaching assignments and Roster memberships share: each is a Person's
 * participation in a Class Offering, bounded by School dates inside its Term
 * (ADR-0011), stored, made, moved and ended the same way. Each kind keeps only
 * what sets it apart: see ./teaching-assignments.ts and ./roster-memberships.ts.
 *
 * Only this School-date pair is shared. Enrollments and School memberships are
 * bounded by instants, and are kept apart from it (ADR-0011).
 */

/** One Person's participation in one Class Offering, as stored. */
export interface Participation {
  id: string;
  schoolId: string;
  classOfferingId: string;
  personId: string;
  firstDate: SchoolDate;
  /** Null while it is open: it runs to the end of its Term. */
  lastDate: SchoolDate | null;
}

/** The bounds of a participation: an open one has no last date, and runs to the end of its Term. */
export interface Bounds {
  firstDate: SchoolDate;
  lastDate: SchoolDate | null;
}

/** A participation locked for the rest of the transaction, with the last School date of its Term. */
export type LockedParticipation = Participation & { termLastDate: SchoolDate };

/** One participation a change made, removed, or altered: `before` is null for one made, `after` for one removed. */
export interface ChangedParticipation {
  before: Participation | null;
  after: Participation | null;
}

/** What sets one kind of participation apart where it is stored. */
interface KindOfParticipation {
  /** Its table in the `app` schema, and the name its Audit records and refusals give it. */
  kind: "teaching_assignment" | "roster_membership";
  /** The column naming whose it is. */
  personColumn: "faculty_person_id" | "student_person_id";
  /** The rules the database holds for its own bounds, as the Conflicts they stand for. */
  boundsConflicts: Readonly<Record<string, ConflictDetail>>;
}

export type Participations = ReturnType<typeof participationsIn>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One kind of participation as stored. A Person taking part twice in one
 * offering holds two rows that never overlap, and one that has begun is ended
 * rather than deleted, as the record of who took part and when.
 *
 * Nothing here decides whether anyone may see or change one: that is the
 * decision in ./index.ts, made before any of this is reached.
 */
export function participationsIn({ kind, personColumn, boundsConflicts }: KindOfParticipation) {
  const table = `app.${kind}`;
  const columns = `p.id, p.school_id AS "schoolId", p.class_offering_id AS "classOfferingId",
    p.${personColumn} AS "personId", to_char(p.first_date, 'YYYY-MM-DD') AS "firstDate",
    to_char(p.last_date, 'YYYY-MM-DD') AS "lastDate"`;
  const withTerm = `${table} p
    JOIN app.class_offering o ON o.school_id = p.school_id AND o.id = p.class_offering_id
    JOIN app.term t ON t.school_id = o.school_id AND t.id = o.term_id`;
  /** The last School date one runs to, open or not: an open one runs to the end of its Term. Needs `withTerm`. */
  const runsTo = `coalesce(p.last_date, t.last_date)`;

  /** Deletes a locked participation. Only one that has not begun is deleted: see its grant in migrations. */
  async function remove(transaction: Queryable, participation: Participation): Promise<void> {
    await transaction.query(`DELETE FROM ${table} WHERE school_id = $1 AND id = $2`, [
      participation.schoolId,
      participation.id,
    ]);
  }

  /**
   * Moves a locked participation's bounds, refusing them as making it would.
   * Returns it as it was and as it is, or null when the change states what it
   * holds.
   */
  async function setBounds(
    transaction: Queryable,
    participation: Participation,
    { firstDate, lastDate }: Bounds,
  ): Promise<ChangedParticipation | null> {
    if (firstDate === participation.firstDate && lastDate === participation.lastDate) {
      return null;
    }
    const { rows } = await withConstraintsNamed(boundsConflicts, () =>
      transaction.query<Participation>(
        `UPDATE ${table} AS p SET first_date = $3, last_date = $4
         WHERE p.school_id = $1 AND p.id = $2
         RETURNING ${columns}`,
        [participation.schoolId, participation.id, firstDate, lastDate],
      ),
    );
    return { before: participation, after: rows[0]! };
  }

  return {
    kind,
    remove,
    setBounds,

    /** Every participation in these Class Offerings, ended ones included. */
    async on(database: Queryable, classOfferingIds: readonly string[]): Promise<Participation[]> {
      const { rows } = await database.query<Participation>(
        `SELECT ${columns} FROM ${table} p
         WHERE p.class_offering_id = ANY($1::uuid[])
         ORDER BY p.first_date, p.id`,
        [classOfferingIds],
      );
      return rows;
    },

    /** Every participation this Person holds, ended ones included. */
    async of(database: Queryable, person: Pick<Person, "id" | "schoolId">): Promise<Participation[]> {
      const { rows } = await database.query<Participation>(
        `SELECT ${columns} FROM ${table} p
         WHERE p.school_id = $1 AND p.${personColumn} = $2
         ORDER BY p.first_date, p.id`,
        [person.schoolId, person.id],
      );
      return rows;
    },

    /** The participation with this identifier, in whichever School holds it, or null. */
    async find(database: Queryable, id: string): Promise<Participation | null> {
      if (!UUID.test(id)) {
        return null;
      }
      const { rows } = await database.query<Participation>(`SELECT ${columns} FROM ${table} p WHERE p.id = $1`, [id]);
      return rows[0] ?? null;
    },

    /**
     * Locks a participation until the transaction ends, and returns it as it
     * now stands with the last School date of its Term, or null if it was
     * deleted since it was found. Only for one the caller has already been
     * permitted to change: see lockPermittedParticipation.
     */
    async lock(
      transaction: Queryable,
      participation: Participation,
    ): Promise<LockedParticipation | null> {
      const { rows } = await transaction.query<LockedParticipation>(
        `SELECT ${columns}, to_char(t.last_date, 'YYYY-MM-DD') AS "termLastDate"
         FROM ${withTerm}
         WHERE p.school_id = $1 AND p.id = $2
         FOR UPDATE OF p`,
        [participation.schoolId, participation.id],
      );
      return rows[0] ?? null;
    },

    /**
     * Makes a Person's participation in a Class Offering, or refuses bounds
     * that overlap one of their own in it or fall outside its Term. Whether the
     * Person may take part at all is the caller's to have checked.
     */
    async create(transaction: Queryable, participation: Omit<Participation, "id">): Promise<Participation> {
      const { rows } = await withConstraintsNamed(boundsConflicts, () =>
        transaction.query<Participation>(
          `INSERT INTO ${table} AS p (school_id, class_offering_id, ${personColumn}, first_date, last_date)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING ${columns}`,
          [
            participation.schoolId,
            participation.classOfferingId,
            participation.personId,
            participation.firstDate,
            participation.lastDate,
          ],
        ),
      );
      return rows[0]!;
    },

    /**
     * Ends every participation of this Person's still running after this
     * School date: on that date, or, for one that would only have begun after
     * it, by deleting it, since it never began. Returns each as it was and as
     * it is.
     */
    async endEachOf(
      transaction: Queryable,
      person: Pick<Person, "id" | "schoolId">,
      endsOn: SchoolDate,
    ): Promise<ChangedParticipation[]> {
      const { rows } = await transaction.query<Participation>(
        `SELECT ${columns} FROM ${withTerm}
         WHERE p.school_id = $1 AND p.${personColumn} = $2 AND ${runsTo} > $3
         ORDER BY p.first_date, p.id
         FOR UPDATE OF p`,
        [person.schoolId, person.id, endsOn],
      );
      const changed: ChangedParticipation[] = [];
      for (const participation of rows) {
        if (participation.firstDate > endsOn) {
          await remove(transaction, participation);
          changed.push({ before: participation, after: null });
        } else {
          // Inside the Term still: it begins no later than this date, and ran past it.
          changed.push((await setBounds(transaction, participation, { ...participation, lastDate: endsOn }))!);
        }
      }
      return changed;
    },

    /** How many of this Person's participations ending them on this School date would end: see endEachOf. */
    async countRunningPast(
      database: Queryable,
      person: Pick<Person, "id" | "schoolId">,
      endsOn: SchoolDate,
    ): Promise<number> {
      const { rows } = await database.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${withTerm}
         WHERE p.school_id = $1 AND p.${personColumn} = $2 AND ${runsTo} > $3`,
        [person.schoolId, person.id, endsOn],
      );
      return rows[0]!.count;
    },

    /** The Class Offerings this Person ever took part in, whether or not their participation has ended. */
    async classOfferingIdsOf(database: Queryable, person: Person): Promise<Set<string>> {
      const { rows } = await database.query<{ classOfferingId: string }>(
        `SELECT DISTINCT class_offering_id AS "classOfferingId" FROM ${table}
         WHERE school_id = $1 AND ${personColumn} = $2`,
        [person.schoolId, person.id],
      );
      return new Set(rows.map((row) => row.classOfferingId));
    },

    /**
     * The Class Offerings this Person ever took part in, each with whether any
     * of their participations in it still runs on or after this School date.
     */
    async classOfferingsOf(
      database: Queryable,
      person: Person,
      today: SchoolDate,
    ): Promise<Map<string, { current: boolean }>> {
      const { rows } = await database.query<{ classOfferingId: string; current: boolean }>(
        `SELECT p.class_offering_id AS "classOfferingId", bool_or(${runsTo} >= $3) AS current
         FROM ${withTerm}
         WHERE p.school_id = $1 AND p.${personColumn} = $2
         GROUP BY p.class_offering_id`,
        [person.schoolId, person.id, today],
      );
      return new Map(rows.map(({ classOfferingId, current }) => [classOfferingId, { current }]));
    },
  };
}

/*
 * What the two kinds share as requests. Validation below runs only once the
 * Access decision has permitted the caller: see InvalidRequest.
 */

/** A last date: absent when not stated, null for an open participation, or a School date. */
export function lastDateFrom(fields: Record<string, unknown>): SchoolDate | null | undefined {
  const value = fields["lastDate"];
  return value === undefined || value === null ? value : schoolDateFrom(value, "lastDate");
}

/** A first date: absent when not stated, or a School date. */
export function firstDateFrom(fields: Record<string, unknown>): SchoolDate | undefined {
  return fields["firstDate"] === undefined ? undefined : schoolDateFrom(fields["firstDate"], "firstDate");
}

/** A change of bounds: whatever it states of them, over what the participation already holds. */
export function boundsFrom(body: unknown, held: Bounds): Bounds & { reason: string | null } {
  const fields = fieldsOf(body, ["firstDate", "lastDate", "reason"]);
  const lastDate = lastDateFrom(fields);
  return {
    firstDate: firstDateFrom(fields) ?? held.firstDate,
    lastDate: lastDate === undefined ? held.lastDate : lastDate,
    reason: reasonFrom(fields["reason"]),
  };
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

type Action = "created" | "changed" | "ended" | "deleted";

/** Records a change to a participation, naming the offering and Person it joins. */
export async function recordChange(
  transaction: Queryable,
  actor: Actor,
  participations: Participations,
  action: Action,
  { before, after }: ChangedParticipation,
  reason: string | null,
): Promise<void> {
  const valuesOf = ({ classOfferingId, personId, firstDate, lastDate }: Participation): AuditValues => ({
    classOfferingId,
    personId,
    firstDate,
    lastDate,
  });
  await appendAuditRecord(transaction, {
    schoolId: actor.schoolId,
    actorPersonId: actor.person.id,
    action: `${participations.kind}.${action}`,
    target: { type: participations.kind, id: (after ?? before)!.id },
    reason,
    before: before === null ? null : valuesOf(before),
    after: after === null ? null : valuesOf(after),
  });
}

/**
 * Ends a locked participation today: one that has not begun has held nothing,
 * and is removed instead. Records what it did, and returns the participation
 * as it now is; one already over by today ends nothing, and is returned as it
 * was, with nothing recorded.
 */
export async function endToday(
  transaction: Queryable,
  actor: Actor,
  participations: Participations,
  { termLastDate, ...participation }: LockedParticipation,
  reason: string | null,
): Promise<Participation> {
  const at = await transactionTime(transaction);
  const today = (await schoolDateAt(transaction, { schoolId: participation.schoolId, at }))!;
  if (participation.firstDate > today) {
    await participations.remove(transaction, participation);
    await recordChange(transaction, actor, participations, "deleted", { before: participation, after: null }, reason);
    return participation;
  }
  if ((participation.lastDate ?? termLastDate) <= today) {
    return participation;
  }
  const ended = (await participations.setBounds(transaction, participation, { ...participation, lastDate: today }))!;
  await recordChange(transaction, actor, participations, "ended", ended, reason);
  return ended.after!;
}

/**
 * Ends every participation of this Person's still running after this School
 * date, as endEachOf does, recording each as the change that ended what it
 * required, with its reason. Called by that change's own transaction, once it
 * is made, so the two end together.
 */
export async function endEachWith(
  transaction: Queryable,
  actor: Actor,
  participations: Participations,
  person: Pick<Person, "id" | "schoolId">,
  endsOn: SchoolDate,
  reason: string | null,
): Promise<void> {
  for (const changed of await participations.endEachOf(transaction, person, endsOn)) {
    await recordChange(transaction, actor, participations, changed.after === null ? "deleted" : "ended", changed, reason);
  }
}
