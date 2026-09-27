import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import type { Person } from "../src/identity/index.ts";
import { observable, useTestServer, type TestClient, type TestResponse } from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const BOB = { username: "bob", password: "yet another staple, longer" };
const FRANKIE = { username: "frankie", password: "a faculty member's staple" };
const CASEY = { username: "casey", password: "a co-teacher's staple" };
const DANA = { username: "dana", password: "a newly assigned staple" };
const ELLIS = { username: "ellis", password: "a former teacher's staple" };
const SAM = { username: "sam", password: "a student's staple, first" };
const GINA = { username: "gina", password: "a guardian's staple, twice over" };
const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

type Status = "present" | "tardy" | "excused_absence" | "unexcused_absence" | "absent_pending_review";

interface Named {
  id: string;
  displayName: string;
}

interface Session {
  classOfferingId: string;
  date: string;
  today: string;
  lastRecordableDate: string;
  readOnlyBecause: string | null;
  opened: { by: Named; at: string } | null;
  students: {
    person: Named;
    markable: boolean;
    attendance: { status: Status; recordedBy: Named; recordedAt: string } | null;
  }[];
}

interface Saved {
  attendanceSession: Session;
  refusedMarks: {
    studentPersonId: string;
    because: string;
    attendance: { status: Status; recordedBy: Named; recordedAt: string } | null;
  }[];
}

interface Recorded {
  actorPersonId: string | null;
  action: string;
  target: { type: string; id: string | null };
  before: unknown;
  after: unknown;
}

/** The School date `days` after this one, which may be negative. */
function shifted(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

describe("Attendance sessions", () => {
  const server = useTestServer();

  interface World {
    schoolId: string;
    /** Alice: Northside's School Administrator. */
    alice: TestClient;
    aliceId: string;
    /** Bob: Westbrook's School Administrator, and nothing at Northside. */
    bob: TestClient;
    /** Frankie and Casey: Faculty co-teaching the offering all Term. */
    frankie: TestClient;
    frankiePerson: Person;
    casey: TestClient;
    caseyPerson: Person;
    /** Dana: Faculty assigned to the offering from today only. */
    dana: TestClient;
    /** Ellis: Faculty whose assignment to the offering ended yesterday. */
    ellis: TestClient;
    /** Sam and Sky: Students enrolled and rostered all Term. */
    sam: TestClient;
    samPerson: Person;
    skyPerson: Person;
    /** Lee: rostered all Term, but their Enrollment ended three days ago. */
    leePerson: Person;
    /** Gina: Sam's Guardian. */
    gina: TestClient;
    /** Northside's School date today. */
    today: string;
    /** An Instructional day inside the window, before today. */
    earlier: string;
    /** A date inside the Term taken out of the year's Instructional days. */
    dayOff: string;
    offering: { id: string };
  }

  /**
   * Northside's year runs sixty days either side of today, every day of the
   * week an Instructional day but one, in one Term. Its window is the default,
   * seven days.
   */
  async function arrange(): Promise<World> {
    const aliceAccount = await server().createAccount(ALICE);
    const bobAccount = await server().createAccount(BOB);
    const northside = await server().provisionSchool({ name: "Northside", administrator: aliceAccount });
    const westbrook = await server().provisionSchool({ name: "Westbrook", administrator: bobAccount });
    const schoolId = northside.school.id;
    const alice = (await server().sessionFor(aliceAccount)).inSchool(schoolId);
    const today = ((await alice.get("/school-date")).body as { schoolDate: string }).schoolDate;
    const year = await alice.post("/academic-years", {
      name: "The year",
      firstDate: shifted(today, -60),
      lastDate: shifted(today, 60),
      weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    });
    expect(year.status).toBe(201);
    const { academicYear } = year.body as { academicYear: { id: string } };
    const divided = await alice.patch(`/academic-years/${academicYear.id}`, {
      terms: [{ name: "Whole", firstDate: shifted(today, -60), lastDate: shifted(today, 60) }],
    });
    expect(divided.status).toBe(200);
    const [term] = (divided.body as { academicYear: { terms: { id: string }[] } }).academicYear.terms;
    const dayOff = shifted(today, -2);
    expect((await alice.post(`/academic-years/${academicYear.id}/exceptions`, { date: dayOff, instructional: false })).status).toBe(201);
    const course = await alice.post("/courses", { name: "Algebra I" });
    const offered = await alice.post("/class-offerings", {
      courseId: (course.body as { course: { id: string } }).course.id,
      termId: term!.id,
    });
    expect(offered.status).toBe(201);
    const offering = (offered.body as { classOffering: { id: string } }).classOffering;

    const person = async (credentials: { username: string; password: string } | null, displayName: string, role: "faculty" | "student" | "guardian") => {
      const account = credentials === null ? undefined : await server().createAccount(credentials);
      const created = await server().createPerson({ schoolId, displayName, role, ...(account === undefined ? {} : { account }) });
      return { person: created, client: account === undefined ? null : (await server().sessionFor(account)).inSchool(schoolId) };
    };
    const assign = async (faculty: Person, bounds: { firstDate?: string; lastDate?: string } = {}) => {
      const assigned = await alice.post(`/class-offerings/${offering.id}/teaching-assignments`, { personId: faculty.id, ...bounds });
      expect(assigned.status).toBe(201);
    };
    const frankie = await person(FRANKIE, "Frankie", "faculty");
    const casey = await person(CASEY, "Casey", "faculty");
    const dana = await person(DANA, "Dana", "faculty");
    const ellis = await person(ELLIS, "Ellis", "faculty");
    await assign(frankie.person);
    await assign(casey.person);
    await assign(dana.person, { firstDate: today });
    await assign(ellis.person, { firstDate: shifted(today, -60), lastDate: shifted(today, -1) });

    const sam = await person(SAM, "Sam", "student");
    const sky = await person(null, "Sky", "student");
    const lee = await person(null, "Lee", "student");
    for (const student of [sam.person, sky.person, lee.person]) {
      await server().enroll(student);
    }
    const rostered = await alice.post(`/class-offerings/${offering.id}/roster-memberships`, {
      personIds: [sam.person.id, sky.person.id, lee.person.id],
    });
    expect(rostered.status).toBe(201);
    // Ended as if three days ago, leaving the membership open.
    await server().ownerDatabase.query(
      `UPDATE app.enrollment
       SET started_at = now() - interval '30 days', ended_at = now() - interval '3 days', end_reason = 'Moved away'
       WHERE student_person_id = $1`,
      [lee.person.id],
    );
    const gina = await person(GINA, "Gina", "guardian");
    expect(
      (await alice.post("/guardian-links", {
        guardianPersonId: gina.person.id,
        studentPersonId: sam.person.id,
        accessProfile: { attendanceRead: true, resultsRead: true },
      })).status,
    ).toBe(201);

    return {
      schoolId,
      alice,
      aliceId: northside.schoolAdministrator.id,
      bob: (await server().sessionFor(bobAccount)).inSchool(westbrook.school.id),
      frankie: frankie.client!,
      frankiePerson: frankie.person,
      casey: casey.client!,
      caseyPerson: casey.person,
      dana: dana.client!,
      ellis: ellis.client!,
      sam: sam.client!,
      samPerson: sam.person,
      skyPerson: sky.person,
      leePerson: lee.person,
      gina: gina.client!,
      today,
      earlier: shifted(today, -3),
      dayOff,
      offering,
    };
  }

  const path = (world: World) => `/class-offerings/${world.offering.id}/attendance-session`;

  async function open(world: World, as: TestClient, date: string): Promise<Session> {
    const response = await as.post(path(world), { date });
    expect(response.status).toBe(201);
    return (response.body as { attendanceSession: Session }).attendanceSession;
  }

  async function read(world: World, as: TestClient, date?: string): Promise<Session> {
    const response = await as.get(`${path(world)}${date === undefined ? "" : `?date=${date}`}`);
    expect(response.status).toBe(200);
    return (response.body as { attendanceSession: Session }).attendanceSession;
  }

  async function save(
    world: World,
    as: TestClient,
    date: string,
    marks: { studentPersonId: string; loaded: Status | null; status: Status }[],
    markAllPresent?: boolean,
  ): Promise<Saved> {
    const response = await as.patch(path(world), { date, marks, ...(markAllPresent === undefined ? {} : { markAllPresent }) });
    expect(response.status).toBe(200);
    return response.body as Saved;
  }

  function statusesOf(session: Session): Record<string, Status | null> {
    return Object.fromEntries(session.students.map((student) => [student.person.displayName, student.attendance?.status ?? null]));
  }

  async function trailOf(admin: TestClient, ...actions: string[]): Promise<Recorded[]> {
    const response = await admin.get("/audit-records");
    expect(response.status).toBe(200);
    return (response.body as { auditRecords: Recorded[] }).auditRecords.filter((record) => actions.includes(record.action));
  }

  it("opens one session per date, capturing the roster unmarked, shared by co-teachers and read by the School Administrator", async () => {
    const world = await arrange();

    const opened = await open(world, world.frankie, world.today);
    const sharedByCasey = await open(world, world.casey, world.today);
    const readByCasey = await read(world, world.casey);
    const readByAlice = await read(world, world.alice, world.today);
    const earlier = await open(world, world.frankie, world.earlier);

    expect(opened).toEqual({
      classOfferingId: world.offering.id,
      date: world.today,
      today: world.today,
      lastRecordableDate: shifted(world.today, 7),
      readOnlyBecause: null,
      opened: { by: { id: world.frankiePerson.id, displayName: "Frankie" }, at: expect.any(String) },
      students: [
        { person: { id: world.leePerson.id, displayName: "Lee" }, markable: false, attendance: null },
        { person: { id: world.samPerson.id, displayName: "Sam" }, markable: true, attendance: null },
        { person: { id: world.skyPerson.id, displayName: "Sky" }, markable: true, attendance: null },
      ],
    });
    expect(sharedByCasey).toEqual(opened);
    expect(readByCasey).toEqual(opened);
    expect(readByAlice).toEqual({ ...opened, readOnlyBecause: "not_teaching" });
    expect(earlier).toEqual(expect.objectContaining({ date: world.earlier, readOnlyBecause: null }));
    // Lee's Enrollment ended three days ago, so the day it ended they could still be marked.
    expect(earlier.students.find((student) => student.person.id === world.leePerson.id)?.markable).toBe(true);
    const { rows } = await server().ownerDatabase.query(`SELECT date::text FROM app.attendance_session ORDER BY date`);
    expect(rows).toEqual([{ date: world.earlier }, { date: world.today }]);
  });

  it("refuses each condition of the recording rule on its own", async () => {
    const world = await arrange();
    await open(world, world.frankie, world.today);
    const refusal = await world.frankie.get(`/persons/${ABSENT_ID}`);
    const mark = [{ studentPersonId: world.samPerson.id, loaded: null, status: "present" }];

    const cases: [string, TestClient, string, number, unknown][] = [
      ["a date Dana's assignment did not cover", world.dana, world.earlier, 404, null],
      ["Ellis's ended assignment", world.ellis, world.today, 404, null],
      ["a date that is not an Instructional day", world.frankie, world.dayOff, 409, "not_instructional_day"],
      // No assignment reaches outside its Term, so that is refused as a date not taught.
      ["a date outside the Term", world.frankie, shifted(world.today, -61), 404, null],
      ["a date after today", world.frankie, shifted(world.today, 1), 409, "after_today"],
      ["a date whose window has closed", world.frankie, shifted(world.today, -8), 409, "attendance_window_closed"],
    ];
    const answered: string[] = [];
    for (const [what, as, date, status, conflict] of cases) {
      for (const response of [
        await as.post(path(world), { date }),
        await as.patch(path(world), { date, marks: mark }),
      ]) {
        const expected =
          status === 404 ? observable(refusal) : { status: 409, body: { status: "conflict", conflict } };
        const actual = status === 404 ? observable(response) : { status: response.status, body: response.body };
        if (!isDeepStrictEqual(actual, expected)) {
          answered.push(`${what} answered ${response.status}`);
        }
      }
    }
    // Each is read-only for the same reason when read.
    const why = async (as: TestClient, date: string) => (await read(world, as, date)).readOnlyBecause;
    const reasons = [
      await why(world.dana, world.earlier),
      await why(world.ellis, world.today),
      await why(world.frankie, world.dayOff),
      await why(world.frankie, shifted(world.today, 1)),
      await why(world.frankie, shifted(world.today, -8)),
    ];
    const lee = await save(world, world.frankie, world.today, [
      { studentPersonId: world.leePerson.id, loaded: null, status: "present" },
      { studentPersonId: world.samPerson.id, loaded: null, status: "present" },
    ]);
    const uncaptured = await world.frankie.patch(path(world), {
      date: world.today,
      marks: [{ studentPersonId: world.frankiePerson.id, loaded: null, status: "present" }],
    });

    expect(answered).toEqual([]);
    expect(reasons).toEqual(["not_taught_on_date", "not_teaching", "not_instructional_day", "after_today", "window_closed"]);
    expect(lee.refusedMarks).toEqual([{ studentPersonId: world.leePerson.id, because: "not_markable", attendance: null }]);
    expect(statusesOf(lee.attendanceSession)).toEqual({ Lee: null, Sam: "present", Sky: null });
    expect(uncaptured.status).toBe(400);
    const { rows } = await server().ownerDatabase.query(`SELECT count(*)::int AS count FROM app.attendance_session`);
    expect(rows).toEqual([{ count: 1 }]);
  });

  it("marks only unmarked Students with Mark all Present, saves with Students left unmarked, and names who marked each when", async () => {
    const world = await arrange();
    await open(world, world.frankie, world.today);

    const partial = await save(world, world.frankie, world.today, [
      { studentPersonId: world.samPerson.id, loaded: null, status: "tardy" },
    ]);
    const all = await save(world, world.casey, world.today, [], true);

    expect(statusesOf(partial.attendanceSession)).toEqual({ Lee: null, Sam: "tardy", Sky: null });
    expect(statusesOf(all.attendanceSession)).toEqual({ Lee: null, Sam: "tardy", Sky: "present" });
    expect(all.refusedMarks).toEqual([]);
    const [, sam, sky] = all.attendanceSession.students;
    expect(sam!.attendance).toEqual({
      status: "tardy",
      recordedBy: { id: world.frankiePerson.id, displayName: "Frankie" },
      recordedAt: expect.any(String),
    });
    expect(sky!.attendance?.recordedBy).toEqual({ id: world.caseyPerson.id, displayName: "Casey" });
    expect(Date.now() - Date.parse(sky!.attendance!.recordedAt)).toBeLessThan(60_000);
    // A first mark is not audited: the record names its own recorder and time.
    expect(await trailOf(world.alice, "attendance.changed", "attendance.recorded")).toEqual([]);
  });

  it("refuses a stale mark with its current value while the rest of the save applies, and audits each change", async () => {
    const world = await arrange();
    await open(world, world.frankie, world.today);
    await save(world, world.frankie, world.today, [{ studentPersonId: world.samPerson.id, loaded: null, status: "present" }]);
    // Casey changes Sam after Frankie loaded the session.
    await save(world, world.casey, world.today, [
      { studentPersonId: world.samPerson.id, loaded: "present", status: "unexcused_absence" },
    ]);

    const saved = await save(world, world.frankie, world.today, [
      { studentPersonId: world.samPerson.id, loaded: "present", status: "excused_absence" },
      { studentPersonId: world.skyPerson.id, loaded: null, status: "present" },
    ]);
    const unchanged = await save(world, world.frankie, world.today, [
      { studentPersonId: world.samPerson.id, loaded: "unexcused_absence", status: "unexcused_absence" },
    ]);

    expect(saved.refusedMarks).toEqual([
      {
        studentPersonId: world.samPerson.id,
        because: "stale",
        attendance: {
          status: "unexcused_absence",
          recordedBy: { id: world.caseyPerson.id, displayName: "Casey" },
          recordedAt: expect.any(String),
        },
      },
    ]);
    expect(statusesOf(saved.attendanceSession)).toEqual({ Lee: null, Sam: "unexcused_absence", Sky: "present" });
    expect(unchanged.refusedMarks).toEqual([]);
    const changed = await trailOf(world.alice, "attendance.changed");
    expect(changed).toEqual([
      expect.objectContaining({
        actorPersonId: world.caseyPerson.id,
        target: { type: "attendance", id: expect.any(String) },
        before: { studentPersonId: world.samPerson.id, classOfferingId: world.offering.id, date: world.today, status: "present" },
        after: {
          studentPersonId: world.samPerson.id,
          classOfferingId: world.offering.id,
          date: world.today,
          status: "unexcused_absence",
        },
      }),
    ]);
  });

  it("locks an Absent-pending-review against Faculty changes inside the window", async () => {
    const world = await arrange();
    await open(world, world.frankie, world.today);
    await save(world, world.frankie, world.today, [
      { studentPersonId: world.samPerson.id, loaded: null, status: "absent_pending_review" },
    ]);

    const attempts = [
      await save(world, world.frankie, world.today, [
        { studentPersonId: world.samPerson.id, loaded: "absent_pending_review", status: "excused_absence" },
      ]),
      await save(world, world.casey, world.today, [
        { studentPersonId: world.samPerson.id, loaded: "absent_pending_review", status: "present" },
      ]),
    ];

    for (const { refusedMarks, attendanceSession } of attempts) {
      expect(refusedMarks).toEqual([
        {
          studentPersonId: world.samPerson.id,
          because: "absent_pending_review",
          attendance: expect.objectContaining({ status: "absent_pending_review" }),
        },
      ]);
      expect(statusesOf(attendanceSession)["Sam"]).toBe("absent_pending_review");
    }
    expect(await trailOf(world.alice, "attendance.changed")).toEqual([]);
  });

  it("refreshes the snapshot with newly rostered Students, never removes one, and is refused once the window closes", async () => {
    const world = await arrange();
    await open(world, world.frankie, world.earlier);
    const newcomer = await server().createPerson({ schoolId: world.schoolId, displayName: "Nia", role: "student" });
    await server().enroll(newcomer);
    expect(
      (await world.alice.post(`/class-offerings/${world.offering.id}/roster-memberships`, { personIds: [newcomer.id] }))
        .status,
    ).toBe(201);
    // Sky's membership is moved to begin after the session's date.
    const { classOffering } = (await world.alice.get(`/class-offerings/${world.offering.id}`)).body as {
      classOffering: { rosterMemberships: { id: string; person: Named }[] };
    };
    const sky = classOffering.rosterMemberships.find((membership) => membership.person.id === world.skyPerson.id)!;
    expect((await world.alice.patch(`/roster-memberships/${sky.id}`, { firstDate: world.today })).status).toBe(200);

    const before = await read(world, world.frankie, world.earlier);
    const refreshed = await open(world, world.casey, world.earlier);
    expect((await world.alice.patch("/settings", { attendanceWindow: 2 })).status).toBe(200);
    const closed = await world.frankie.post(path(world), { date: world.earlier });

    expect(before.students.map((student) => student.person.displayName)).toEqual(["Lee", "Sam", "Sky"]);
    expect(refreshed.students.map((student) => [student.person.displayName, student.markable])).toEqual([
      ["Lee", true],
      ["Nia", true],
      ["Sam", true],
      ["Sky", false],
    ]);
    // Still opened by Frankie: a refresh is not an opening.
    expect(refreshed.opened?.by.id).toBe(world.frankiePerson.id);
    expect(closed.status).toBe(409);
    expect(closed.body).toEqual({ status: "conflict", conflict: "attendance_window_closed" });
    // Neither opening nor refreshing is audited.
    expect(await trailOf(world.alice, "attendance.changed", "attendance_session.opened")).toEqual([]);
  });

  it("gives every other role, and a caller from another School, the one refusal", async () => {
    const world = await arrange();
    await open(world, world.frankie, world.today);
    const refusal = await world.frankie.get(`/persons/${ABSENT_ID}`);
    const body = { date: world.today, marks: [{ studentPersonId: world.samPerson.id, loaded: null, status: "present" }] };
    const bobInNorthside = world.bob.inSchool(world.schoolId);
    const attempts: [string, () => Promise<TestResponse>][] = [
      ["the School Administrator opening", () => world.alice.post(path(world), { date: world.today })],
      ["the School Administrator saving", () => world.alice.patch(path(world), body)],
      ["a Student reading", () => world.sam.get(path(world))],
      ["a Student opening", () => world.sam.post(path(world), { date: world.today })],
      ["a Student saving", () => world.sam.patch(path(world), body)],
      ["a Guardian reading", () => world.gina.get(path(world))],
      ["a Guardian saving", () => world.gina.patch(path(world), body)],
      ["another School's Administrator reading", () => bobInNorthside.get(path(world))],
      ["another School's Administrator saving", () => bobInNorthside.patch(path(world), body)],
      ["a caller with no session", () => server().client.inSchool(world.schoolId).get(path(world))],
      ["reading an offering that does not exist", () => world.frankie.get(`/class-offerings/${ABSENT_ID}/attendance-session`)],
    ];

    const answered: string[] = [];
    for (const [what, attempt] of attempts) {
      const response = await attempt();
      if (!isDeepStrictEqual(observable(response), observable(refusal))) {
        answered.push(`${what} answered ${response.status}`);
      }
    }

    expect(answered).toEqual([]);
    const { rows } = await server().ownerDatabase.query(`SELECT count(*)::int AS count FROM app.attendance`);
    expect(rows).toEqual([{ count: 0 }]);
  });
});
