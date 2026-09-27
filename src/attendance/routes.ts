import type { FastifyInstance } from "fastify";
import {
  authorizeReadAttendanceOf,
  authorizeReadAttendanceOfStudent,
  authorizeRecordAttendance,
  recordingRefusal,
  type Actor,
} from "../access/index.ts";
import { presentOffering } from "../academic-structure/course-routes.ts";
import {
  classOfferingsInSchool,
  findClassOffering,
  type DescribedClassOffering,
} from "../academic-structure/courses.ts";
import { appendAuditRecord } from "../audit/index.ts";
import type { Authenticator } from "../authentication/index.ts";
import { schoolDateAt, schoolDatePlus, type SchoolDate } from "../calendar/index.ts";
import type { Database } from "../db/pool.ts";
import { transactionTime, withTransaction, type Queryable } from "../db/transaction.ts";
import { Conflict } from "../http/conflict.ts";
import { InvalidRequest } from "../http/invalid-request.ts";
import { fieldsOf, schoolDateFrom } from "../http/request-body.ts";
import { registerSchoolScope } from "../http/school-scope.ts";
import { findPerson, findPersons, schoolSettingsOf } from "../identity/index.ts";
import {
  ATTENDANCE_STATUSES,
  attendanceOn,
  captureRoster,
  capturedStudents,
  changeAttendance,
  dateProblem,
  findSession,
  isAttendanceStatus,
  openSession,
  recordAttendance,
  type Attendance,
  type AttendanceStatus,
  type DateProblem,
  type MarkRefusal,
  type ReadOnlyBecause,
} from "./sessions.ts";
import { classOfferingAttendance, studentAttendance } from "./totals.ts";

/**
 * The most marks one save carries. A class of any real size fits well inside
 * it; the bound is there so one request cannot hold a session locked over an
 * unbounded list.
 */
const MAX_MARKS_AT_ONCE = 200;

interface Mark {
  studentPersonId: string;
  loaded: AttendanceStatus | null;
  status: AttendanceStatus;
}

/** Someone named on a session, by display name alone. */
interface Named {
  id: string;
  displayName: string;
}

interface ServedAttendance {
  status: AttendanceStatus;
  recordedBy: Named;
  recordedAt: string;
}

// Validation below runs only once the Access decision has permitted the
// caller: see InvalidRequest.

const SAVE_FIELDS = ["date", "marks", "markAllPresent"];

/**
 * The School date a save is for, read on its own: whether the actor may record
 * depends on it, so it is read once they may read the offering, and the rest
 * of the save only once they may record (see parseSave).
 */
function saveDateFrom(body: unknown): SchoolDate {
  return schoolDateFrom(fieldsOf(body, SAVE_FIELDS)["date"], "date");
}

function parseSave(body: unknown): { marks: Mark[]; markAllPresent: boolean } {
  const fields = fieldsOf(body, SAVE_FIELDS);
  const marks = fields["marks"] ?? [];
  if (!Array.isArray(marks)) {
    throw new InvalidRequest("marks must be a list");
  }
  if (marks.length > MAX_MARKS_AT_ONCE) {
    throw new InvalidRequest(`marks may hold at most ${MAX_MARKS_AT_ONCE} marks`);
  }
  const parsed = marks.map((mark: unknown): Mark => {
    const { studentPersonId, loaded, status } = fieldsOf(mark, ["studentPersonId", "loaded", "status"]);
    if (typeof studentPersonId !== "string" || studentPersonId.length === 0) {
      throw new InvalidRequest("each mark's studentPersonId must name a Student");
    }
    if (!isAttendanceStatus(status) || (loaded !== null && !isAttendanceStatus(loaded))) {
      throw new InvalidRequest(
        `each mark's status, and its loaded value unless null, must be one of ${ATTENDANCE_STATUSES.join(", ")}`,
      );
    }
    return { studentPersonId, loaded, status };
  });
  if (new Set(parsed.map((mark) => mark.studentPersonId)).size !== parsed.length) {
    throw new InvalidRequest("marks must name each Student once");
  }
  const markAllPresent = fields["markAllPresent"] ?? false;
  if (typeof markAllPresent !== "boolean") {
    throw new InvalidRequest("markAllPresent must be true or false");
  }
  return { marks: parsed, markAllPresent };
}

/** The School's today, and the date's own reason it cannot be recorded, if any. */
async function dateStanding(database: Queryable, offering: DescribedClassOffering, date: SchoolDate) {
  const { schoolId, term } = offering;
  const today = (await schoolDateAt(database, { schoolId, at: await transactionTime(database) }))!;
  // The actor's own School, so it exists.
  const { attendanceWindow } = (await schoolSettingsOf(database, schoolId))!;
  const problem = await dateProblem(database, { schoolId, term, date, today, attendanceWindow });
  return { today, attendanceWindow, problem };
}

/** Refuses a date whose Attendance cannot be recorded, whoever asks. */
function checkRecordable(problem: DateProblem | null): void {
  if (problem !== null) {
    throw new Conflict({ conflict: problem });
  }
}

/**
 * The session as the actor is served it: the date, the School's today, the
 * last School date its window lets it be recorded on, why it is read-only for
 * them if it is, who opened it when, and each captured Student with their
 * Attendance and whether they can be marked. A Student marked but never
 * captured, as a Correction request may leave one, is listed too, and cannot
 * be marked here.
 */
async function serveSession(database: Queryable, actor: Actor, offering: DescribedClassOffering, date: SchoolDate) {
  const { today, attendanceWindow, problem } = await dateStanding(database, offering, date);
  const refusal = await recordingRefusal(database, actor, offering, date);
  const readOnlyBecause: ReadOnlyBecause | null =
    problem === "not_instructional_day" || problem === "after_today" ? problem : (refusal ?? problem);
  const key = { schoolId: offering.schoolId, classOfferingId: offering.id, date };
  const session = await findSession(database, key);
  const captured = session === null ? [] : await capturedStudents(database, session);
  const marks = await attendanceOn(database, key);
  const persons = await findPersons(database, [
    ...captured.map((student) => student.studentPersonId),
    ...marks.flatMap((mark) => [mark.studentPersonId, mark.recordedByPersonId]),
    ...(session === null ? [] : [session.openedByPersonId]),
  ]);
  const named = (id: string): Named => ({ id, displayName: persons.get(id)?.displayName ?? "" });
  const markOf = new Map(marks.map((mark) => [mark.studentPersonId, mark]));
  const unmarkable = new Map(captured.map((student) => [student.studentPersonId, student.unmarkableBecause]));
  const studentIds = [...new Set([...unmarkable.keys(), ...markOf.keys()])];
  return {
    classOfferingId: offering.id,
    date,
    today,
    lastRecordableDate: schoolDatePlus(date, attendanceWindow),
    readOnlyBecause,
    opened: session === null ? null : { by: named(session.openedByPersonId), at: session.openedAt.toISOString() },
    students: studentIds
      .map((id) => {
        const mark = markOf.get(id);
        return {
          person: named(id),
          // One marked but never captured is not rostered on the date as far as this session knows.
          unmarkableBecause: unmarkable.has(id) ? unmarkable.get(id)! : ("not_rostered_on_date" as const),
          attendance: mark === undefined ? null : serveAttendance(mark, named),
        };
      })
      .sort(byName),
  };
}

/** By the Student's display name, and by identifier between two of one name. */
function byName(a: { person: Named }, b: { person: Named }): number {
  return a.person.displayName.localeCompare(b.person.displayName) || a.person.id.localeCompare(b.person.id);
}

function serveAttendance(mark: Attendance, named: (id: string) => Named): ServedAttendance {
  return { status: mark.status, recordedBy: named(mark.recordedByPersonId), recordedAt: mark.recordedAt.toISOString() };
}

/**
 * Records the change of an existing mark, for the reason given, if any. A
 * first mark is not audited: it names its own recorder and time.
 */
export async function recordChange(
  transaction: Queryable,
  actor: Actor,
  before: Attendance,
  after: Attendance,
  reason: string | null = null,
) {
  const valuesOf = ({ studentPersonId, classOfferingId, date, status }: Attendance) => ({
    studentPersonId,
    classOfferingId,
    date,
    status,
  });
  await appendAuditRecord(transaction, {
    schoolId: actor.schoolId,
    actorPersonId: actor.person.id,
    action: "attendance.changed",
    target: { type: "attendance", id: after.id },
    reason,
    before: valuesOf(before),
    after: valuesOf(after),
  });
}

/**
 * Attendance sessions: one per Class Offering and School date, shared by
 * every Faculty member who may record it (CONTEXT.md: Attendance session).
 *
 * Reading one, or the offering's Attendance as a whole with each Student's
 * Attendance totals, is for anyone who may read the offering's Attendance: a
 * School Administrator, or Faculty ever assigned to it. One Student's own
 * Attendance and totals, in every Class Offering they were rostered in, are
 * read by that Student, a Guardian their link permits, and a School
 * Administrator. Attendance is read as soon as it is recorded, and never
 * publishes. Opening
 * it, refreshing its Roster snapshot, and saving marks are for a Faculty
 * member whose Teaching assignment covers the date and is active now, on an
 * Instructional day of the Term up to the School's today, inside its
 * Attendance window. Every decision on who may is the Access module's, asked
 * before anything else about the request is looked at.
 */
export function registerAttendanceRoutes(app: FastifyInstance, database: Database, authenticator: Authenticator): void {
  registerSchoolScope(app, database, authenticator, (scope) => {
    /** The offering the actor may read the Attendance of, named in the path. */
    const readableOffering = async (actor: Actor, classOfferingId: string) =>
      authorizeReadAttendanceOf(actor, classOfferingId, await findClassOffering(database, classOfferingId));

    // Every mark by date, and each Student's Attendance totals, for the
    // offering's Term up to the School's today, computed as it is read.
    scope.get("/class-offerings/:classOfferingId/attendance", async (actor, { params }) => {
      const offering = await readableOffering(actor, params["classOfferingId"]!);
      const today = (await schoolDateAt(database, { schoolId: offering.schoolId, at: await transactionTime(database) }))!;
      const { dates, students } = await classOfferingAttendance(database, { offering, today });
      const persons = await findPersons(database, [
        ...students.flatMap((student) => [
          student.studentPersonId,
          ...student.attendance.map((mark) => mark.recordedByPersonId),
        ]),
      ]);
      const named = (id: string): Named => ({ id, displayName: persons.get(id)?.displayName ?? "" });
      return {
        classOfferingAttendance: {
          classOfferingId: offering.id,
          today,
          dates,
          students: students
            .map(({ studentPersonId, rosterMemberships, attendance, totals }) => ({
              person: named(studentPersonId),
              rosterMemberships,
              attendance: attendance.map((mark) => ({ date: mark.date, ...serveAttendance(mark, named) })),
              totals,
            }))
            .sort(byName),
        },
      };
    });

    // One Student's own Attendance and totals in each Class Offering they were
    // rostered in or marked in, up to the School's today: the latest Term
    // first, and by Course within it. Nothing of any classmate's, nor who
    // recorded each mark.
    scope.get("/persons/:personId/attendance", async (actor, { params }) => {
      const personId = params["personId"]!;
      const student = authorizeReadAttendanceOfStudent(actor, personId, await findPerson(database, personId));
      const today = (await schoolDateAt(database, { schoolId: student.schoolId, at: await transactionTime(database) }))!;
      const own = await studentAttendance(database, {
        schoolId: student.schoolId,
        studentPersonId: student.id,
        offerings: await classOfferingsInSchool(database, student.schoolId),
        today,
      });
      const classOfferings = own.map(({ offering, ...rest }) => ({ ...presentOffering(offering), ...rest }));
      return {
        studentAttendance: {
          student: { id: student.id, displayName: student.displayName },
          today,
          classOfferings,
        },
      };
    });

    // The session on `date`, or on the School's today when none is named. One
    // nobody has opened is served with no one captured.
    scope.get("/class-offerings/:classOfferingId/attendance-session", async (actor, { params, query }) => {
      const offering = await readableOffering(actor, params["classOfferingId"]!);
      const date =
        query["date"] === undefined
          ? (await schoolDateAt(database, { schoolId: offering.schoolId, at: await transactionTime(database) }))!
          : schoolDateFrom(query["date"], "date");
      return { attendanceSession: await serveSession(database, actor, offering, date) };
    });

    // Opens the session, capturing the Roster memberships covering its date,
    // or refreshes one already open: it adds those rostered since, and never
    // removes a Student captured.
    scope.post("/class-offerings/:classOfferingId/attendance-session", async (actor, { params, body }) => {
      const readable = await readableOffering(actor, params["classOfferingId"]!);
      const date = schoolDateFrom(fieldsOf(body, ["date"])["date"], "date");
      return withTransaction(database, async (transaction) => {
        const offering = await authorizeRecordAttendance(transaction, actor, readable, date);
        checkRecordable((await dateStanding(transaction, offering, date)).problem);
        const { session } = await openSession(transaction, {
          schoolId: offering.schoolId,
          classOfferingId: offering.id,
          date,
          openedByPersonId: actor.person.id,
        });
        await captureRoster(transaction, session);
        return { attendanceSession: await serveSession(transaction, actor, offering, date) };
      });
    });

    // Saves marks, each carrying the value the caller loaded. A mark whose
    // stored value differs is refused with its current value, as is one the
    // rule refuses, and the rest still apply. Marking all present marks every
    // Student still unmarked once those are applied.
    scope.patch("/class-offerings/:classOfferingId/attendance-session", async (actor, { params, body }) => {
      const readable = await readableOffering(actor, params["classOfferingId"]!);
      const date = saveDateFrom(body);
      return withTransaction(database, async (transaction) => {
        const offering = await authorizeRecordAttendance(transaction, actor, readable, date);
        const { marks, markAllPresent } = parseSave(body);
        checkRecordable((await dateStanding(transaction, offering, date)).problem);
        const key = { schoolId: offering.schoolId, classOfferingId: offering.id, date };
        const { session, opened } = await openSession(transaction, { ...key, openedByPersonId: actor.person.id });
        if (opened) {
          await captureRoster(transaction, session);
        }
        const markable = new Map(
          (await capturedStudents(transaction, session)).map((student) => [
            student.studentPersonId,
            student.unmarkableBecause === null,
          ]),
        );
        const stored = new Map(
          (await attendanceOn(transaction, key, { lock: true })).map((mark) => [mark.studentPersonId, mark]),
        );
        if (marks.some((mark) => !markable.has(mark.studentPersonId))) {
          throw new InvalidRequest("marks must name Students the session's Roster snapshot captured");
        }
        const refused: { studentPersonId: string; because: MarkRefusal; attendance: Attendance | null }[] = [];
        const record = async (studentPersonId: string, status: AttendanceStatus) =>
          recordAttendance(transaction, { ...key, studentPersonId, status, recordedByPersonId: actor.person.id });
        for (const { studentPersonId, loaded, status } of marks) {
          const current = stored.get(studentPersonId) ?? null;
          const refuse = (because: MarkRefusal) => refused.push({ studentPersonId, because, attendance: current });
          if ((current?.status ?? null) !== loaded) {
            refuse("stale");
          } else if (current?.status === status) {
            continue;
          } else if (!markable.get(studentPersonId)) {
            refuse("not_markable");
          } else if (current === null) {
            stored.set(studentPersonId, await record(studentPersonId, status));
          } else if (current.status === "absent_pending_review") {
            refuse("absent_pending_review");
          } else {
            const changed = await changeAttendance(transaction, current, { status, recordedByPersonId: actor.person.id });
            await recordChange(transaction, actor, current, changed);
          }
        }
        if (markAllPresent) {
          for (const [studentPersonId, canMark] of markable) {
            if (canMark && !stored.has(studentPersonId)) {
              await record(studentPersonId, "present");
            }
          }
        }
        const served = await serveSession(transaction, actor, offering, date);
        const persons = await findPersons(
          transaction,
          refused.flatMap(({ attendance }) => (attendance === null ? [] : [attendance.recordedByPersonId])),
        );
        const named = (id: string): Named => ({ id, displayName: persons.get(id)?.displayName ?? "" });
        return {
          attendanceSession: served,
          refusedMarks: refused.map(({ studentPersonId, because, attendance }) => ({
            studentPersonId,
            because,
            attendance: attendance === null ? null : serveAttendance(attendance, named),
          })),
        };
      });
    });
  });
}
