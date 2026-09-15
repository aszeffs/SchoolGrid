import type { Queryable } from "../db/transaction.ts";
import type { Person } from "../identity/index.ts";

/**
 * Guardian links as stored. Each links one Guardian to one Student and carries
 * that link's Access profile; a Guardian of two Students holds two rows with
 * nothing linking them. Rows are never deleted, and who they link never
 * changes: a link's profile can change, and it can end (migrations/0006).
 *
 * Nothing here decides whether anyone may see or change a link: that is the
 * decision in ./index.ts, made before any of this is reached.
 */

/**
 * Two independent permissions, not named modes, so any combination can be
 * held. Stored and returned only: nothing reads with them until Attendance and
 * Term results exist, and those slices enforce them.
 */
export interface AccessProfile {
  attendanceRead: boolean;
  resultsRead: boolean;
}

export interface GuardianLink {
  id: string;
  schoolId: string;
  guardianPersonId: string;
  studentPersonId: string;
  accessProfile: AccessProfile;
  createdAt: Date;
  /** Null while the link is in force. */
  endedAt: Date | null;
}

const LINK_COLUMNS = `id, school_id AS "schoolId", guardian_person_id AS "guardianPersonId",
  student_person_id AS "studentPersonId",
  json_build_object('attendanceRead', attendance_read, 'resultsRead', results_read) AS "accessProfile",
  created_at AS "createdAt", ended_at AS "endedAt"`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Records a link in force from now, or returns null when the Guardian already
 * holds one in force to this Student. The unique index decides that, so two
 * links made at once cannot both succeed.
 */
export async function linkGuardian(
  transaction: Queryable,
  {
    guardian,
    student,
    accessProfile,
  }: { guardian: Person; student: Person; accessProfile: AccessProfile },
): Promise<GuardianLink | null> {
  const { rows } = await transaction.query<GuardianLink>(
    `INSERT INTO app.guardian_link
       (school_id, guardian_person_id, student_person_id, attendance_read, results_read)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (school_id, guardian_person_id, student_person_id) WHERE ended_at IS NULL
     DO NOTHING
     RETURNING ${LINK_COLUMNS}`,
    [
      guardian.schoolId,
      guardian.id,
      student.id,
      accessProfile.attendanceRead,
      accessProfile.resultsRead,
    ],
  );
  return rows[0] ?? null;
}

/** The link with this identifier, in whichever School holds it, or null. */
export async function findGuardianLink(
  database: Queryable,
  guardianLinkId: string,
): Promise<GuardianLink | null> {
  if (!UUID.test(guardianLinkId)) {
    return null;
  }
  const { rows } = await database.query<GuardianLink>(
    `SELECT ${LINK_COLUMNS} FROM app.guardian_link WHERE id = $1`,
    [guardianLinkId],
  );
  return rows[0] ?? null;
}

/**
 * Locks a link until the transaction ends, so two changes to it cannot
 * interleave, and returns it as it now stands.
 *
 * Only for a link the caller has already been permitted to change, for the
 * reason given at lockMembership: a lock taken before the decision makes a
 * refusal's timing depend on what exists.
 */
export async function lockGuardianLink(
  transaction: Queryable,
  link: GuardianLink,
): Promise<GuardianLink> {
  const { rows } = await transaction.query<GuardianLink>(
    `SELECT ${LINK_COLUMNS} FROM app.guardian_link
     WHERE school_id = $1 AND id = $2
     FOR UPDATE`,
    [link.schoolId, link.id],
  );
  return rows[0]!;
}

/** Sets a link's Access profile. Who it links, and when it began, never change. */
export async function setAccessProfile(
  transaction: Queryable,
  guardianLinkId: string,
  accessProfile: AccessProfile,
): Promise<GuardianLink> {
  const { rows } = await transaction.query<GuardianLink>(
    `UPDATE app.guardian_link SET attendance_read = $2, results_read = $3
     WHERE id = $1
     RETURNING ${LINK_COLUMNS}`,
    [guardianLinkId, accessProfile.attendanceRead, accessProfile.resultsRead],
  );
  return rows[0]!;
}

/** Ends a link now. The row stays, as the record of when the access was held. */
export async function endGuardianLinkNow(
  transaction: Queryable,
  guardianLinkId: string,
): Promise<GuardianLink> {
  const { rows } = await transaction.query<GuardianLink>(
    `UPDATE app.guardian_link SET ended_at = now()
     WHERE id = $1
     RETURNING ${LINK_COLUMNS}`,
    [guardianLinkId],
  );
  return rows[0]!;
}

/**
 * Ends every link in force to this Student now, and returns each as it ended.
 * The rows stay, as the record of when the access was held.
 */
export async function endGuardianLinksTo(
  transaction: Queryable,
  student: Pick<Person, "id" | "schoolId">,
): Promise<GuardianLink[]> {
  const { rows } = await transaction.query<GuardianLink>(
    `UPDATE app.guardian_link SET ended_at = now()
     WHERE school_id = $1 AND student_person_id = $2 AND ended_at IS NULL
     RETURNING ${LINK_COLUMNS}`,
    [student.schoolId, student.id],
  );
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
}

/** The Students this Person holds a link in force to, as a Guardian. */
export async function linkedStudentIds(database: Queryable, guardian: Person): Promise<Set<string>> {
  const { rows } = await database.query<{ studentPersonId: string }>(
    `SELECT student_person_id AS "studentPersonId" FROM app.guardian_link
     WHERE school_id = $1 AND guardian_person_id = $2 AND ended_at IS NULL`,
    [guardian.schoolId, guardian.id],
  );
  return new Set(rows.map((row) => row.studentPersonId));
}

/** Every link in the School, ended ones included, oldest first. */
export async function guardianLinksInSchool(
  database: Queryable,
  schoolId: string,
): Promise<GuardianLink[]> {
  const { rows } = await database.query<GuardianLink>(
    `SELECT ${LINK_COLUMNS} FROM app.guardian_link
     WHERE school_id = $1
     ORDER BY created_at, id`,
    [schoolId],
  );
  return rows;
}
