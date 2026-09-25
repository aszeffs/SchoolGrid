import { createAcademicYear, changeAcademicYear, addException, WORKING_WEEK } from "../academic-structure/index.ts";
import { createClassOffering, createCourse } from "../academic-structure/courses.ts";
import {
  assignTeaching,
  grantMembership,
  linkGuardian,
  recordEnrollment,
  rosterStudent,
  ROLES,
  type Role,
} from "../access/index.ts";
import { appendAuditRecord } from "../audit/index.ts";
import type { UserAccount } from "../authentication/index.ts";
import { schoolDateAt } from "../calendar/index.ts";
import { transactionTime, type Queryable } from "../db/transaction.ts";
import { createPerson, createSchool, type Person, type School } from "../identity/index.ts";
import { INVENTED_SCHOOL_NAME, inventedSchool, NO_LABEL } from "./invented-school.ts";

/**
 * The Trials module starts Trial Schools, lets their visitor change role
 * within one, and deletes those that have expired (CONTEXT.md: Trial School,
 * ADR-0012).
 *
 * A Trial School is a School: once started, every authorization, Safe denial
 * and Audit behaviour applies to it unchanged. What is particular to it is
 * only its expiry, its role accounts, and its deletion.
 */

/** How long a Trial School lives. */
export const TRIAL_LIFETIME_MS = 2 * 60 * 60 * 1000;

/**
 * Taken by every trial start for the rest of its transaction, so two starts
 * cannot both count the same live trials and between them pass the cap.
 */
const TRIAL_START_LOCK = 0x7472_6961_6c;

/** A Trial School just started, and the account its visitor first acts as. */
export interface StartedTrial {
  school: School;
  expiresAt: Date;
  schoolAdministrator: UserAccount;
}

/**
 * Deletes every Trial School past its expiry, with everything in it, and says
 * how many. The database decides which, and refuses any other School
 * (migrations/0018).
 */
export async function deleteExpiredTrialSchools(database: Queryable): Promise<number> {
  const { rows } = await database.query<{ deleted: number }>(`SELECT app.delete_expired_trial_schools() AS deleted`);
  return rows[0]!.deleted;
}

/**
 * Starts a Trial School of invented data in the School's own timezone, with a
 * role account for each School role, or returns null, starting nothing, when
 * `liveCap` Trial Schools are live already.
 *
 * Everything is built in the caller's transaction, so a trial exists whole or
 * not at all.
 */
export async function startTrialSchool(
  transaction: Queryable,
  { timezone, liveCap }: { timezone: string; liveCap: number },
): Promise<StartedTrial | null> {
  await transaction.query(`SELECT pg_advisory_xact_lock($1)`, [TRIAL_START_LOCK]);
  const { rows } = await transaction.query<{ live: number }>(
    `SELECT count(*)::integer AS live FROM app.school WHERE trial_expires_at > now()`,
  );
  if (rows[0]!.live >= liveCap) {
    return null;
  }

  const now = await transactionTime(transaction);
  const expiresAt = new Date(now.getTime() + TRIAL_LIFETIME_MS);
  const school = await createSchool(transaction, { name: INVENTED_SCHOOL_NAME, timezone, trialExpiresAt: expiresAt });
  // Built around today as the School sees it, so its dates look right to the visitor.
  const invented = inventedSchool((await schoolDateAt(transaction, { schoolId: school.id, at: now }))!);

  const accounts = new Map<Role, UserAccount>();
  const rolePersons = new Map<Role, Person>();
  for (const role of ROLES) {
    const account = await createRoleAccount(transaction, { school, role });
    const person = await createPerson(transaction, {
      schoolId: school.id,
      userAccountId: account.id,
      displayName: invented.rolePersons[role],
    });
    await grantMembership(transaction, { person, role });
    accounts.set(role, account);
    rolePersons.set(role, person);
  }
  // Recorded in the School's own trail, as provisioning is. No Person started
  // it: a visitor did, from outside any School.
  await appendAuditRecord(transaction, {
    schoolId: school.id,
    actorPersonId: null,
    action: "trial.started",
    target: { type: "school", id: school.id },
    reason: null,
    before: null,
    after: { timezone, trialExpiresAt: expiresAt.toISOString() },
  });

  const faculty = rolePersons.get("faculty")!;
  const student = rolePersons.get("student")!;
  const otherFaculty = await Promise.all(
    invented.otherFaculty.map((displayName) => createPerson(transaction, { schoolId: school.id, displayName })),
  );
  const students = new Map<string, Person>([[student.displayName, student]]);
  for (const displayName of invented.otherStudents) {
    students.set(displayName, await createPerson(transaction, { schoolId: school.id, displayName }));
  }
  for (const person of otherFaculty) {
    await grantMembership(transaction, { person, role: "faculty" });
  }
  for (const person of students.values()) {
    if (person !== student) {
      await grantMembership(transaction, { person, role: "student" });
    }
    await recordEnrollment(transaction, person);
  }
  await linkGuardian(transaction, {
    guardian: rolePersons.get("guardian")!,
    student,
    accessProfile: { attendanceRead: true, resultsRead: true },
  });

  const created = await createAcademicYear(transaction, {
    schoolId: school.id,
    ...invented.academicYear,
    weekdays: [...WORKING_WEEK],
  });
  let { year } = await changeAcademicYear(transaction, created, {
    ...invented.academicYear,
    weekdays: WORKING_WEEK,
    terms: invented.terms.map((term) => ({ id: null, ...term })),
  });
  for (const date of invented.holidays) {
    ({ year } = await addException(transaction, year, { date, instructional: false }));
  }

  for (const { name, code, labels, taughtByRole, rosters } of invented.courses) {
    const course = await createCourse(transaction, { schoolId: school.id, name, code });
    const assigned = taughtByRole ? faculty : otherFaculty[0]!;
    for (const term of year.terms) {
      for (const label of labels) {
        const offering = await createClassOffering(transaction, { course, term, label });
        const firstDate = term.firstDate;
        await assignTeaching(transaction, {
          schoolId: school.id,
          classOfferingId: offering.id,
          personId: assigned.id,
          firstDate,
          lastDate: null,
        });
        for (const displayName of rosters[label ?? NO_LABEL] ?? []) {
          await rosterStudent(transaction, {
            schoolId: school.id,
            classOfferingId: offering.id,
            personId: students.get(displayName)!.id,
            firstDate,
            lastDate: null,
          });
        }
      }
    }
  }

  return { school, expiresAt, schoolAdministrator: accounts.get("school_administrator")! };
}

/**
 * The role account for this School role in the live Trial School whose role
 * account this is, or null: for any other account, an account an Invitation
 * created in the trial included, and in a trial that has expired. Only the
 * visitor, acting as one of the trial's roles, changes between them.
 */
export async function roleAccountFor(
  database: Queryable,
  { account, role }: { account: UserAccount; role: Role },
): Promise<UserAccount | null> {
  const { rows } = await database.query<UserAccount>(
    `SELECT target.id, target.username
     FROM app.user_account caller
     JOIN app.school school ON school.id = caller.created_in_school_id
     JOIN app.user_account target ON target.created_in_school_id = school.id AND target.trial_role = $2
     WHERE caller.id = $1 AND caller.trial_role IS NOT NULL AND school.trial_expires_at > now()`,
    [account.id, role],
  );
  return rows[0] ?? null;
}

/**
 * The one account a Trial School holds for a School role. It has no password
 * and can never be given one (migrations/0018): the visitor acts as it only
 * through a Session the trial issues.
 */
async function createRoleAccount(
  transaction: Queryable,
  { school, role }: { school: School; role: Role },
): Promise<UserAccount> {
  const { rows } = await transaction.query<UserAccount>(
    `INSERT INTO app.user_account (username, password_hash, created_in_school_id, trial_role)
     VALUES ($1, NULL, $2, $3)
     RETURNING id, username`,
    [`trial-${school.id}-${role}`, school.id, role],
  );
  return rows[0]!;
}
