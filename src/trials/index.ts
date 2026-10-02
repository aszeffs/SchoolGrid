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
import { raiseCorrectionRequest } from "../correction-requests/index.ts";
import { currentResultValueIds, publishTermResults, recordTermResults, termResultsIn } from "../results/term-results.ts";
import { recordTakenSessions, type TakenSession } from "../attendance/sessions.ts";
import { appendAuditRecord } from "../audit/index.ts";
import type { UserAccount } from "../authentication/index.ts";
import { instructionalDaysBetween, schoolDateAt, schoolDatePlus } from "../calendar/index.ts";
import { transactionTime, type Queryable } from "../db/transaction.ts";
import { createPerson, createSchool, schoolSettingsOf, type Person, type School } from "../identity/index.ts";
import { INVENTED_SCHOOL_NAME, inventedAttendance, inventedResults, inventedSchool, NO_LABEL } from "./invented-school.ts";

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
 * Taken by every trial sign-in for the rest of its transaction, so two cannot
 * both count the same live trials and between them pass the cap, nor both
 * find one visitor with no live trial and start them two.
 */
const TRIAL_START_LOCK = 0x7472_6961_6c;

/** The Trial School a visitor signed in to, and the account they act as in it. */
export interface EnteredTrial {
  schoolId: string;
  schoolAdministrator: UserAccount;
  /** Whether it was already theirs and live, rather than started now. */
  resumed: boolean;
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
 * The Trial visitor this identity names (ADR-0013) enters their Trial School:
 * the live one they have, or a new one when they have none. Returns null,
 * starting nothing, when they have none and `liveCap` Trial Schools are live
 * already. `visitor` is the keyed hash `visitorIdentity` makes, never the
 * subject itself.
 *
 * Everything is done in the caller's transaction, under the start lock, so a
 * visitor signing in twice at once still has one live trial, and a new one
 * exists whole or not at all.
 */
export async function enterTrialSchool(
  transaction: Queryable,
  { timezone, liveCap, visitor }: { timezone: string; liveCap: number; visitor: Buffer },
): Promise<EnteredTrial | null> {
  await transaction.query(`SELECT pg_advisory_xact_lock($1)`, [TRIAL_START_LOCK]);
  const live = await transaction.query<{ schoolId: string; id: string; username: string }>(
    `SELECT school.id AS "schoolId", account.id, account.username
     FROM app.trial_visitor visitor
     JOIN app.school school ON school.trial_visitor_id = visitor.id
     JOIN app.user_account account ON account.created_in_school_id = school.id AND account.trial_role = 'school_administrator'
     WHERE visitor.identity = $1 AND school.trial_expires_at > now()`,
    [visitor],
  );
  if (live.rows.length > 0) {
    const { schoolId, ...schoolAdministrator } = live.rows[0]!;
    return { schoolId, schoolAdministrator, resumed: true };
  }

  const { rows } = await transaction.query<{ live: number }>(
    `SELECT count(*)::integer AS live FROM app.school WHERE trial_expires_at > now()`,
  );
  if (rows[0]!.live >= liveCap) {
    return null;
  }
  const started = await startTrialSchool(transaction, { timezone, visitor });
  return { ...started, resumed: false };
}

/**
 * Starts a Trial School of invented data in the School's own timezone, with a
 * role account for each School role, for this Trial visitor.
 */
async function startTrialSchool(
  transaction: Queryable,
  { timezone, visitor }: { timezone: string; visitor: Buffer },
): Promise<{ schoolId: string; schoolAdministrator: UserAccount }> {
  const now = await transactionTime(transaction);
  const expiresAt = new Date(now.getTime() + TRIAL_LIFETIME_MS);
  const school = await createSchool(transaction, {
    name: INVENTED_SCHOOL_NAME,
    timezone,
    trialExpiresAt: expiresAt,
    trialVisitorId: await trialVisitorFor(transaction, visitor),
  });
  // Built around today as the School sees it, so its dates look right to the visitor.
  const today = (await schoolDateAt(transaction, { schoolId: school.id, at: now }))!;
  const invented = inventedSchool(today);

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

  // Today's Term's offerings, by Course code and label, and who is assigned to each.
  const currentTerm = year.terms.find((term) => term.firstDate <= today && today <= term.lastDate)!;
  const current = new Map<string, { classOfferingId: string; assigned: Person }>();
  for (const { name, code, labels, taughtByRole, rosters } of invented.courses) {
    const course = await createCourse(transaction, { schoolId: school.id, name, code });
    const assigned = taughtByRole ? faculty : otherFaculty[0]!;
    for (const term of year.terms) {
      for (const label of labels) {
        const offering = await createClassOffering(transaction, { course, term, label });
        if (term.id === currentTerm.id) {
          current.set(offeringKey(code, label ?? NO_LABEL), { classOfferingId: offering.id, assigned });
        }
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

  // Taken by the Faculty member assigned to each offering on the Term's days
  // before today, and written as the invented past it is: nothing here is audited.
  const yesterday = schoolDatePlus(today, -1);
  const pastDays =
    yesterday < currentTerm.firstDate
      ? []
      : await instructionalDaysBetween(transaction, { schoolId: school.id, from: currentTerm.firstDate, to: yesterday });
  const { attendanceWindow } = (await schoolSettingsOf(transaction, school.id))!;
  const { marks, correctionRequest } = inventedAttendance(invented, { pastDays, today, attendanceWindow });
  const sessions = new Map<string, TakenSession & { marks: TakenSession["marks"][number][] }>();
  for (const { course, label, student, date, status } of marks) {
    const { classOfferingId, assigned } = current.get(offeringKey(course, label))!;
    let session = sessions.get(`${classOfferingId}|${date}`);
    if (session === undefined) {
      session = { schoolId: school.id, classOfferingId, date, openedByPersonId: assigned.id, marks: [] };
      sessions.set(`${classOfferingId}|${date}`, session);
    }
    session.marks.push({ studentPersonId: students.get(student)!.id, status });
  }
  await recordTakenSessions(transaction, [...sessions.values()]);
  if (correctionRequest !== null) {
    const { course, label, student, ...request } = correctionRequest;
    await raiseCorrectionRequest(transaction, {
      kind: "attendance",
      schoolId: school.id,
      classOfferingId: current.get(offeringKey(course, label))!.classOfferingId,
      studentPersonId: students.get(student)!.id,
      ...request,
      requestedByPersonId: faculty.id,
    });
  }

  // Recorded as drafts by whoever teaches each offering, in the School's
  // first scale, and one offering published by them, unaudited as above.
  const results = inventedResults(invented);
  const valueIds = await currentResultValueIds(transaction, school.id);
  await recordTermResults(
    transaction,
    results.results.map(({ course, label, student, value, score, comment }) => {
      const { classOfferingId, assigned } = current.get(offeringKey(course, label))!;
      return {
        schoolId: school.id,
        classOfferingId,
        studentPersonId: students.get(student)!.id,
        resultValueId: value === null ? null : valueIds.get(value)!,
        score,
        comment,
        recordedByPersonId: assigned.id,
      };
    }),
  );
  const published = current.get(offeringKey(results.published.course, results.published.label))!;
  const publishedKey = { schoolId: school.id, classOfferingId: published.classOfferingId };
  await publishTermResults(transaction, publishedKey, published.assigned.id, await termResultsIn(transaction, publishedKey));
  const resultRequest = results.correctionRequest;
  await raiseCorrectionRequest(transaction, {
    kind: "term_result",
    schoolId: school.id,
    classOfferingId: current.get(offeringKey(resultRequest.course, resultRequest.label))!.classOfferingId,
    studentPersonId: students.get(resultRequest.student)!.id,
    before: resultRequest.before,
    after: resultRequest.after,
    reason: resultRequest.reason,
    requestedByPersonId: faculty.id,
  });

  return { schoolId: school.id, schoolAdministrator: accounts.get("school_administrator")! };
}

/** The Trial visitor with this identity, recorded now if they are not already. */
async function trialVisitorFor(transaction: Queryable, identity: Buffer): Promise<string> {
  await transaction.query(`INSERT INTO app.trial_visitor (identity) VALUES ($1) ON CONFLICT (identity) DO NOTHING`, [
    identity,
  ]);
  const { rows } = await transaction.query<{ id: string }>(`SELECT id FROM app.trial_visitor WHERE identity = $1`, [
    identity,
  ]);
  return rows[0]!.id;
}

/** One invented Class Offering's key: its Course's code and its label, NO_LABEL for none. */
function offeringKey(code: string, label: string): string {
  return `${code}|${label}`;
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
