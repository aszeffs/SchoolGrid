import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import type { Person } from "../src/identity/index.ts";
import { observable, useTestServer, type TestClient, type TestResponse } from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const BOB = { username: "bob", password: "yet another staple, longer" };
const FRANKIE = { username: "frankie", password: "a faculty member's staple" };
const DANA = { username: "dana", password: "a never assigned staple" };
const ELLIS = { username: "ellis", password: "a former teacher's staple" };
const SAM = { username: "sam", password: "a student's staple, first" };
const GINA = { username: "gina", password: "a guardian's staple, twice over" };
const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

type Status = "present" | "tardy" | "excused_absence" | "unexcused_absence" | "absent_pending_review";

interface Named {
  id: string;
  displayName: string;
}

interface OfferingAttendance {
  classOfferingId: string;
  today: string;
  dates: { date: string; instructional: boolean }[];
  students: {
    person: Named;
    rosterMemberships: { firstDate: string; lastDate: string | null }[];
    attendance: { date: string; status: Status; recordedBy: Named; recordedAt: string }[];
    totals: Record<Status | "not_recorded", number>;
  }[];
}

/** The School date `days` after this one, which may be negative. */
function shifted(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

/** Totals with every count zero but those given. */
function totals(counts: Partial<Record<Status | "not_recorded", number>>): Record<Status | "not_recorded", number> {
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

describe("Class Offering Attendance", () => {
  const server = useTestServer();

  interface World {
    schoolId: string;
    /** Alice: Northside's School Administrator. */
    alice: TestClient;
    /** Bob: Westbrook's School Administrator, and nothing at Northside. */
    bob: TestClient;
    /** Frankie: Faculty teaching the offering all Term. */
    frankie: TestClient;
    frankiePerson: Person;
    /** Dana: Faculty never assigned to the offering. */
    dana: TestClient;
    /** Ellis: Faculty whose assignment to the offering ended yesterday. */
    ellis: TestClient;
    /** Sam: rostered all Term. Sky: rostered from three days ago. Lee: rostered for the Term's first three days. */
    sam: TestClient;
    samPerson: Person;
    skyPerson: Person;
    leePerson: Person;
    /** Gina: Sam's Guardian, with attendance read. */
    gina: TestClient;
    today: string;
    academicYearId: string;
    offering: { id: string };
  }

  /**
   * Northside's year, and its one Term, run from nine days ago to ten days on,
   * every day of the week an Instructional day but one, five days ago. The
   * window is wide enough that every day of it so far can still be recorded.
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
      firstDate: shifted(today, -9),
      lastDate: shifted(today, 10),
      weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    });
    expect(year.status).toBe(201);
    const { academicYear } = year.body as { academicYear: { id: string } };
    const divided = await alice.patch(`/academic-years/${academicYear.id}`, {
      terms: [{ name: "Short", firstDate: shifted(today, -9), lastDate: shifted(today, 10) }],
    });
    expect(divided.status).toBe(200);
    const [term] = (divided.body as { academicYear: { terms: { id: string }[] } }).academicYear.terms;
    expect(
      (await alice.post(`/academic-years/${academicYear.id}/exceptions`, { date: shifted(today, -5), instructional: false }))
        .status,
    ).toBe(201);
    expect((await alice.patch("/settings", { attendanceWindow: 30 })).status).toBe(200);
    const course = await alice.post("/courses", { name: "Algebra I" });
    const offered = await alice.post("/class-offerings", {
      courseId: (course.body as { course: { id: string } }).course.id,
      termId: term!.id,
    });
    expect(offered.status).toBe(201);
    const offering = (offered.body as { classOffering: { id: string } }).classOffering;

    const person = async (
      credentials: { username: string; password: string } | null,
      displayName: string,
      role: "faculty" | "student" | "guardian",
    ) => {
      const account = credentials === null ? undefined : await server().createAccount(credentials);
      const created = await server().createPerson({ schoolId, displayName, role, ...(account === undefined ? {} : { account }) });
      return { person: created, client: account === undefined ? null : (await server().sessionFor(account)).inSchool(schoolId) };
    };
    const frankie = await person(FRANKIE, "Frankie", "faculty");
    const dana = await person(DANA, "Dana", "faculty");
    const ellis = await person(ELLIS, "Ellis", "faculty");
    for (const [faculty, bounds] of [
      [frankie.person, {}],
      [ellis.person, { lastDate: shifted(today, -1) }],
    ] as const) {
      const assigned = await alice.post(`/class-offerings/${offering.id}/teaching-assignments`, { personId: faculty.id, ...bounds });
      expect(assigned.status).toBe(201);
    }

    const sam = await person(SAM, "Sam", "student");
    const sky = await person(null, "Sky", "student");
    const lee = await person(null, "Lee", "student");
    for (const [student, bounds] of [
      [sam.person, {}],
      [sky.person, { firstDate: shifted(today, -3) }],
      [lee.person, { lastDate: shifted(today, -7) }],
    ] as const) {
      await server().enroll(student);
      const rostered = await alice.post(`/class-offerings/${offering.id}/roster-memberships`, {
        personIds: [student.id],
        ...bounds,
      });
      expect(rostered.status).toBe(201);
    }
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
      bob: (await server().sessionFor(bobAccount)).inSchool(westbrook.school.id),
      frankie: frankie.client!,
      frankiePerson: frankie.person,
      dana: dana.client!,
      ellis: ellis.client!,
      sam: sam.client!,
      samPerson: sam.person,
      skyPerson: sky.person,
      leePerson: lee.person,
      gina: gina.client!,
      today,
      academicYearId: academicYear.id,
      offering,
    };
  }

  const path = (world: World) => `/class-offerings/${world.offering.id}/attendance`;

  async function read(world: World, as: TestClient): Promise<OfferingAttendance> {
    const response = await as.get(path(world));
    expect(response.status).toBe(200);
    return (response.body as { classOfferingAttendance: OfferingAttendance }).classOfferingAttendance;
  }

  /** Frankie records these statuses, by Student, on the day `days` from today. */
  async function take(world: World, days: number, statuses: [Person, Status][]) {
    const date = shifted(world.today, days);
    const saved = await world.frankie.patch(`/class-offerings/${world.offering.id}/attendance-session`, {
      date,
      marks: statuses.map(([student, status]) => ({ studentPersonId: student.id, loaded: null, status })),
    });
    expect(saved.status).toBe(200);
    expect((saved.body as { refusedMarks: unknown[] }).refusedMarks).toEqual([]);
  }

  it("serves every mark by date and each Student's totals, bounded by today and their Roster membership, leaving out a day that stopped being instructional", async () => {
    const world = await arrange();
    const { samPerson: sam, skyPerson: sky, leePerson: lee } = world;
    await take(world, -9, [[sam, "present"], [lee, "tardy"]]);
    await take(world, -8, [[sam, "excused_absence"], [lee, "unexcused_absence"]]);
    await take(world, -7, [[lee, "absent_pending_review"]]);
    await take(world, -4, [[sam, "present"]]);
    await take(world, -2, [[sam, "unexcused_absence"]]);
    await take(world, -1, [[sam, "tardy"], [sky, "present"]]);
    await take(world, 0, [[sam, "present"]]);
    // Two days ago stops being an Instructional day once Sam's mark on it is recorded.
    const stopped = shifted(world.today, -2);
    expect(
      (await world.alice.post(`/academic-years/${world.academicYearId}/exceptions`, { date: stopped, instructional: false }))
        .status,
    ).toBe(201);

    const attendance = await read(world, world.frankie);

    const on = (days: number) => shifted(world.today, days);
    expect(attendance.classOfferingId).toBe(world.offering.id);
    expect(attendance.today).toBe(world.today);
    // The Term's Instructional days up to today, and the day that stopped being one, which still holds a mark.
    expect(attendance.dates).toEqual([
      ...[-9, -8, -7, -6, -4, -3].map((days) => ({ date: on(days), instructional: true })),
      { date: stopped, instructional: false },
      ...[-1, 0].map((days) => ({ date: on(days), instructional: true })),
    ]);
    expect(attendance.students.map((student) => [student.person, student.rosterMemberships, student.totals])).toEqual([
      [
        { id: lee.id, displayName: "Lee" },
        [{ firstDate: on(-9), lastDate: on(-7) }],
        totals({ tardy: 1, unexcused_absence: 1, absent_pending_review: 1 }),
      ],
      [
        { id: sam.id, displayName: "Sam" },
        [{ firstDate: on(-9), lastDate: null }],
        // Not recorded: seven, six and three days ago. The day off and the day that stopped are not counted.
        totals({ present: 3, tardy: 1, excused_absence: 1, not_recorded: 3 }),
      ],
      [
        { id: sky.id, displayName: "Sky" },
        [{ firstDate: on(-3), lastDate: null }],
        // Not recorded: three days ago and today; nothing before they were rostered, nor after today.
        totals({ present: 1, not_recorded: 2 }),
      ],
    ]);
    const sams = attendance.students.find((student) => student.person.id === sam.id)!;
    expect(sams.attendance.map(({ date, status }) => [date, status])).toEqual([
      [on(-9), "present"],
      [on(-8), "excused_absence"],
      [on(-4), "present"],
      [stopped, "unexcused_absence"],
      [on(-1), "tardy"],
      [on(0), "present"],
    ]);
    expect(sams.attendance[0]).toEqual({
      date: on(-9),
      status: "present",
      recordedBy: { id: world.frankiePerson.id, displayName: "Frankie" },
      recordedAt: expect.any(String),
    });
  });

  it("is read alike by Faculty ever assigned, whose assignment has ended too, and by the School Administrator", async () => {
    const world = await arrange();
    await take(world, -1, [[world.samPerson, "tardy"]]);

    const byFrankie = await read(world, world.frankie);
    const byEllis = await read(world, world.ellis);
    const byAlice = await read(world, world.alice);

    expect(byEllis).toEqual(byFrankie);
    expect(byAlice).toEqual(byFrankie);
    expect(byFrankie.students.find((student) => student.person.id === world.samPerson.id)?.totals.tardy).toBe(1);
  });

  it("gives Faculty never assigned, every other role, and a caller from another School, the one refusal", async () => {
    const world = await arrange();
    await take(world, 0, [[world.samPerson, "present"]]);
    const refusal = await world.frankie.get(`/persons/${ABSENT_ID}`);
    const attempts: [string, () => Promise<TestResponse>][] = [
      ["Faculty never assigned", () => world.dana.get(path(world))],
      ["a Student rostered in it", () => world.sam.get(path(world))],
      ["a Guardian with attendance read", () => world.gina.get(path(world))],
      ["another School's Administrator", () => world.bob.inSchool(world.schoolId).get(path(world))],
      ["a caller with no session", () => server().client.inSchool(world.schoolId).get(path(world))],
      ["an offering that does not exist", () => world.frankie.get(`/class-offerings/${ABSENT_ID}/attendance`)],
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
