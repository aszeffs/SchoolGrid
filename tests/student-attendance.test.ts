import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import type { Person } from "../src/identity/index.ts";
import { observable, useTestServer, type TestClient, type TestResponse } from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const BOB = { username: "bob", password: "yet another staple, longer" };
const FRANKIE = { username: "frankie", password: "a faculty member's staple" };
const SAM = { username: "sam", password: "a student's staple, first" };
const SKY = { username: "sky", password: "a student's staple, second" };
const GINA = { username: "gina", password: "a guardian's staple, twice over" };
const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

type Status = "present" | "tardy" | "excused_absence" | "unexcused_absence" | "absent_pending_review";
type Totals = Record<Status | "not_recorded", number>;

interface StudentAttendance {
  student: { id: string; displayName: string };
  today: string;
  classOfferings: {
    id: string;
    course: { name: string };
    term: { name: string };
    rosterMemberships: { firstDate: string; lastDate: string | null }[];
    attendance: { date: string; status: Status; counted: boolean }[];
    totals: Totals;
  }[];
}

/** The School date `days` after this one, which may be negative. */
function shifted(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

/** Totals with every count zero but those given. */
function totals(counts: Partial<Totals>): Totals {
  return {
    present: 0,
    tardy: 0,
    excused_absence: 0,
    unexcused_absence: 0,
    absent_pending_review: 0,
    not_recorded: 0,
    ...counts,
  };
}

describe("a Student's own Attendance", () => {
  const server = useTestServer();

  interface World {
    schoolId: string;
    /** Alice: Northside's School Administrator. */
    alice: TestClient;
    /** Bob: Westbrook's School Administrator, and nothing at Northside. */
    bob: TestClient;
    /** Frankie: Faculty teaching both offerings all Term. */
    frankie: TestClient;
    /** Sam: rostered in both offerings all Term. */
    sam: TestClient;
    samPerson: Person;
    /** Sky: rostered in Algebra I all Term. */
    sky: TestClient;
    skyPerson: Person;
    /** Gina: Guardian of Sam, with attendance read, and of Sky, without it. */
    gina: TestClient;
    samLinkId: string;
    today: string;
    academicYearId: string;
    algebra: { id: string };
    biology: { id: string };
  }

  /**
   * Northside's year, and its one Term, run from four days ago to ten days on,
   * every day of the week an Instructional day. The window is wide enough that
   * every day of it so far can still be recorded.
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
      firstDate: shifted(today, -4),
      lastDate: shifted(today, 10),
      weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    });
    expect(year.status).toBe(201);
    const { academicYear } = year.body as { academicYear: { id: string } };
    const divided = await alice.patch(`/academic-years/${academicYear.id}`, {
      terms: [{ name: "Short", firstDate: shifted(today, -4), lastDate: shifted(today, 10) }],
    });
    expect(divided.status).toBe(200);
    const [term] = (divided.body as { academicYear: { terms: { id: string }[] } }).academicYear.terms;
    expect((await alice.patch("/settings", { attendanceWindow: 30 })).status).toBe(200);
    const offer = async (name: string) => {
      const course = await alice.post("/courses", { name });
      const offered = await alice.post("/class-offerings", {
        courseId: (course.body as { course: { id: string } }).course.id,
        termId: term!.id,
      });
      expect(offered.status).toBe(201);
      return (offered.body as { classOffering: { id: string } }).classOffering;
    };
    const algebra = await offer("Algebra I");
    const biology = await offer("Biology");

    const person = async (credentials: { username: string; password: string }, displayName: string, role: "faculty" | "student" | "guardian") => {
      const account = await server().createAccount(credentials);
      const created = await server().createPerson({ schoolId, displayName, role, account });
      return { person: created, client: (await server().sessionFor(account)).inSchool(schoolId) };
    };
    const frankie = await person(FRANKIE, "Frankie", "faculty");
    const sam = await person(SAM, "Sam", "student");
    const sky = await person(SKY, "Sky", "student");
    const gina = await person(GINA, "Gina", "guardian");
    for (const offering of [algebra, biology]) {
      const assigned = await alice.post(`/class-offerings/${offering.id}/teaching-assignments`, { personId: frankie.person.id });
      expect(assigned.status).toBe(201);
    }
    for (const [student, offerings] of [
      [sam.person, [algebra, biology]],
      [sky.person, [algebra]],
    ] as const) {
      await server().enroll(student);
      for (const offering of offerings) {
        const rostered = await alice.post(`/class-offerings/${offering.id}/roster-memberships`, { personIds: [student.id] });
        expect(rostered.status).toBe(201);
      }
    }
    const link = async (student: Person, attendanceRead: boolean) => {
      const linked = await alice.post("/guardian-links", {
        guardianPersonId: gina.person.id,
        studentPersonId: student.id,
        accessProfile: { attendanceRead, resultsRead: true },
      });
      expect(linked.status).toBe(201);
      return (linked.body as { guardianLink: { id: string } }).guardianLink.id;
    };
    const samLinkId = await link(sam.person, true);
    await link(sky.person, false);

    return {
      schoolId,
      alice,
      bob: (await server().sessionFor(bobAccount)).inSchool(westbrook.school.id),
      frankie: frankie.client,
      sam: sam.client,
      samPerson: sam.person,
      sky: sky.client,
      skyPerson: sky.person,
      gina: gina.client,
      samLinkId,
      today,
      academicYearId: academicYear.id,
      algebra,
      biology,
    };
  }

  const path = (student: Person | { id: string }) => `/persons/${student.id}/attendance`;

  async function read(as: TestClient, student: Person): Promise<StudentAttendance> {
    const response = await as.get(path(student));
    expect(response.status).toBe(200);
    return (response.body as { studentAttendance: StudentAttendance }).studentAttendance;
  }

  /** Frankie records these statuses, by Student, in this offering on the day `days` from today. */
  async function take(world: World, offering: { id: string }, days: number, statuses: [Person, Status][]) {
    const saved = await world.frankie.patch(`/class-offerings/${offering.id}/attendance-session`, {
      date: shifted(world.today, days),
      marks: statuses.map(([student, status]) => ({ studentPersonId: student.id, loaded: null, status })),
    });
    expect(saved.status).toBe(200);
    expect((saved.body as { refusedMarks: unknown[] }).refusedMarks).toEqual([]);
  }

  it("serves a Student their own Attendance and totals in each Class Offering, a mark on a day no longer instructional shown but not counted", async () => {
    const world = await arrange();
    const { samPerson: sam, skyPerson: sky } = world;
    await take(world, world.algebra, -4, [[sam, "present"], [sky, "tardy"]]);
    await take(world, world.algebra, -3, [[sam, "tardy"]]);
    await take(world, world.algebra, -1, [[sam, "unexcused_absence"]]);
    await take(world, world.biology, 0, [[sam, "absent_pending_review"]]);
    // Three days ago stops being an Instructional day once Sam's mark on it is recorded.
    const stopped = shifted(world.today, -3);
    expect(
      (await world.alice.post(`/academic-years/${world.academicYearId}/exceptions`, { date: stopped, instructional: false }))
        .status,
    ).toBe(201);

    const attendance = await read(world.sam, sam);

    const on = (days: number) => shifted(world.today, days);
    expect(attendance.student).toEqual({ id: sam.id, displayName: "Sam" });
    expect(attendance.today).toBe(world.today);
    expect(
      attendance.classOfferings.map(({ id, course, rosterMemberships, attendance: marks, totals: counted }) => [
        id,
        course.name,
        rosterMemberships,
        marks,
        counted,
      ]),
    ).toEqual([
      [
        world.algebra.id,
        "Algebra I",
        [{ firstDate: on(-4), lastDate: null }],
        [
          { date: on(-4), status: "present", counted: true },
          { date: stopped, status: "tardy", counted: false },
          { date: on(-1), status: "unexcused_absence", counted: true },
        ],
        // Not recorded: two days ago and today. Nothing of Sky's.
        totals({ present: 1, unexcused_absence: 1, not_recorded: 2 }),
      ],
      [
        world.biology.id,
        "Biology",
        [{ firstDate: on(-4), lastDate: null }],
        [{ date: on(0), status: "absent_pending_review", counted: true }],
        totals({ absent_pending_review: 1, not_recorded: 3 }),
      ],
    ]);
  });

  it("is still read by the Student once their Enrollment has ended", async () => {
    const world = await arrange();
    await take(world, world.algebra, -1, [[world.samPerson, "tardy"]]);
    const before = await read(world.sam, world.samPerson);
    const enrollments = (await world.alice.get("/enrollments")).body as {
      enrollments: { id: string; studentPersonId: string }[];
    };
    const enrollment = enrollments.enrollments.find((each) => each.studentPersonId === world.samPerson.id)!;
    expect((await world.alice.delete(`/enrollments/${enrollment.id}`, { reason: "Moved away" })).status).toBe(200);

    const after = await read(world.sam, world.samPerson);

    expect(after.classOfferings.map((offering) => offering.id)).toEqual(before.classOfferings.map((offering) => offering.id));
    expect(after.classOfferings[0]!.attendance).toEqual(before.classOfferings[0]!.attendance);
  });

  it("is read alike by the Student, a Guardian whose link grants attendance read, and the School Administrator; each linked Student by their own link, and nothing once it ends", async () => {
    const world = await arrange();
    await take(world, world.algebra, -2, [[world.samPerson, "excused_absence"]]);
    const refusal = await world.frankie.get(`/persons/${ABSENT_ID}`);

    const bySam = await read(world.sam, world.samPerson);
    const byGina = await read(world.gina, world.samPerson);
    const byAlice = await read(world.alice, world.samPerson);
    const skyByGina = await world.gina.get(path(world.skyPerson));
    expect((await world.alice.delete(`/guardian-links/${world.samLinkId}`, { reason: "No longer a Guardian" })).status).toBe(200);
    const samByGinaEnded = await world.gina.get(path(world.samPerson));

    expect(byGina).toEqual(bySam);
    expect(byAlice).toEqual(bySam);
    expect(bySam.classOfferings[0]!.totals.excused_absence).toBe(1);
    expect(observable(skyByGina)).toEqual(observable(refusal));
    expect(observable(samByGinaEnded)).toEqual(observable(refusal));
  });

  it("gives every other reader, and a caller from another School, the one refusal", async () => {
    const world = await arrange();
    await take(world, world.algebra, 0, [[world.samPerson, "present"]]);
    const refusal = await world.frankie.get(`/persons/${ABSENT_ID}`);
    const attempts: [string, () => Promise<TestResponse>][] = [
      ["another Student", () => world.sky.get(path(world.samPerson))],
      ["Faculty teaching the Student", () => world.frankie.get(path(world.samPerson))],
      ["another School's Administrator", () => world.bob.inSchool(world.schoolId).get(path(world.samPerson))],
      ["a caller with no session", () => server().client.inSchool(world.schoolId).get(path(world.samPerson))],
      ["a Person who does not exist", () => world.alice.get(path({ id: ABSENT_ID }))],
    ];

    const answered: string[] = [];
    for (const [what, attempt] of attempts) {
      const response = await attempt();
      if (!isDeepStrictEqual(observable(response), observable(refusal))) {
        answered.push(`${what} answered ${response.status}`);
      }
    }

    expect(answered).toEqual([]);
  });
});
