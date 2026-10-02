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
const GUS = { username: "gus", password: "a guardian's staple, withheld" };
const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

type Status = "present" | "tardy" | "excused_absence" | "unexcused_absence" | "absent_pending_review";
type Totals = Record<Status | "not_recorded", number>;

interface ReportTerm {
  id: string;
  name: string;
  firstDate: string;
  lastDate: string;
  academicYear: { id: string; name: string };
}

interface TermReport {
  student: { id: string; displayName: string };
  today: string;
  shows: { termResults: boolean; attendanceTotals: boolean };
  terms: ReportTerm[];
  term: ReportTerm | null;
  classOfferings: {
    id: string;
    course: { name: string };
    term: { id: string };
    termResult?: { value: string; score: number | null; comment: string | null; publishedAt: string } | null;
    attendanceTotals?: Totals;
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

describe("the Term report", () => {
  const server = useTestServer();

  interface World {
    schoolId: string;
    /** Alice: Northside's School Administrator. */
    alice: TestClient;
    /** Bob: Westbrook's School Administrator, and nothing at Northside. */
    bob: TestClient;
    /** Frankie: Faculty teaching every offering. */
    frankie: TestClient;
    /** Sam: rostered in Algebra I and Biology this Term, and History last Term. */
    sam: TestClient;
    samPerson: Person;
    /** Sky: rostered in Algebra I this Term. */
    sky: TestClient;
    skyPerson: Person;
    /** Gina: Guardian of Sam with results read alone, and of Sky with attendance read alone. */
    gina: TestClient;
    ginaSamLinkId: string;
    /** Gus: Guardian of Sam with neither. */
    gus: TestClient;
    today: string;
    earlier: { id: string };
    current: { id: string };
    algebra: { id: string };
    biology: { id: string };
    history: { id: string };
  }

  /**
   * Northside's year has two Terms: Earlier, from forty days ago to five
   * days ago, and Current, from four days ago to ten days on, every day an
   * Instructional day.
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
      firstDate: shifted(today, -40),
      lastDate: shifted(today, 10),
      weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    });
    expect(year.status).toBe(201);
    const { academicYear } = year.body as { academicYear: { id: string } };
    const divided = await alice.patch(`/academic-years/${academicYear.id}`, {
      terms: [
        { name: "Earlier", firstDate: shifted(today, -40), lastDate: shifted(today, -5) },
        { name: "Current", firstDate: shifted(today, -4), lastDate: shifted(today, 10) },
      ],
    });
    expect(divided.status).toBe(200);
    const [earlier, current] = (divided.body as { academicYear: { terms: { id: string }[] } }).academicYear.terms;
    expect((await alice.patch("/settings", { attendanceWindow: 30 })).status).toBe(200);
    const offer = async (name: string, term: { id: string }) => {
      const course = await alice.post("/courses", { name });
      const offered = await alice.post("/class-offerings", {
        courseId: (course.body as { course: { id: string } }).course.id,
        termId: term.id,
      });
      expect(offered.status).toBe(201);
      return (offered.body as { classOffering: { id: string } }).classOffering;
    };
    const algebra = await offer("Algebra I", current!);
    const biology = await offer("Biology", current!);
    const history = await offer("History", earlier!);

    const person = async (
      credentials: { username: string; password: string },
      displayName: string,
      role: "faculty" | "student" | "guardian",
    ) => {
      const account = await server().createAccount(credentials);
      const created = await server().createPerson({ schoolId, displayName, role, account });
      return { person: created, client: (await server().sessionFor(account)).inSchool(schoolId) };
    };
    const frankie = await person(FRANKIE, "Frankie", "faculty");
    const sam = await person(SAM, "Sam", "student");
    const sky = await person(SKY, "Sky", "student");
    const gina = await person(GINA, "Gina", "guardian");
    const gus = await person(GUS, "Gus", "guardian");
    for (const offering of [algebra, biology]) {
      const assigned = await alice.post(`/class-offerings/${offering.id}/teaching-assignments`, {
        personId: frankie.person.id,
      });
      expect(assigned.status).toBe(201);
    }
    for (const [student, offerings] of [
      [sam.person, [algebra, biology, history]],
      [sky.person, [algebra]],
    ] as const) {
      await server().enroll(student);
      for (const offering of offerings) {
        const rostered = await alice.post(`/class-offerings/${offering.id}/roster-memberships`, {
          personIds: [student.id],
        });
        expect(rostered.status).toBe(201);
      }
    }
    const link = async (guardian: Person, student: Person, accessProfile: { attendanceRead: boolean; resultsRead: boolean }) => {
      const linked = await alice.post("/guardian-links", {
        guardianPersonId: guardian.id,
        studentPersonId: student.id,
        accessProfile,
      });
      expect(linked.status).toBe(201);
      return (linked.body as { guardianLink: { id: string } }).guardianLink.id;
    };
    const ginaSamLinkId = await link(gina.person, sam.person, { attendanceRead: false, resultsRead: true });
    await link(gina.person, sky.person, { attendanceRead: true, resultsRead: false });
    await link(gus.person, sam.person, { attendanceRead: false, resultsRead: false });

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
      ginaSamLinkId,
      gus: gus.client,
      today,
      earlier: earlier!,
      current: current!,
      algebra,
      biology,
      history,
    };
  }

  const path = (student: { id: string }, term?: { id: string }) =>
    `/persons/${student.id}/term-report${term === undefined ? "" : `?termId=${term.id}`}`;

  async function read(as: TestClient, student: Person, term?: { id: string }): Promise<TermReport> {
    const response = await as.get(path(student, term));
    expect(response.status).toBe(200);
    return (response.body as { termReport: TermReport }).termReport;
  }

  /**
   * Algebra I: Sam's Tardy four days ago, then B, 84 and a comment for Sam and
   * C for Sky, published. Biology: Sam's A, a draft never published. Sam is
   * Present in Biology yesterday.
   */
  async function record(world: World) {
    const mark = async (offering: { id: string }, days: number, marks: [Person, Status][]) => {
      const saved = await world.frankie.patch(`/class-offerings/${offering.id}/attendance-session`, {
        date: shifted(world.today, days),
        marks: marks.map(([student, status]) => ({ studentPersonId: student.id, loaded: null, status })),
      });
      expect(saved.status).toBe(200);
    };
    await mark(world.algebra, -4, [[world.samPerson, "tardy"]]);
    await mark(world.biology, -1, [[world.samPerson, "present"]]);
    const draft = async (offering: { id: string }, drafts: [Person, { value: string; score: number | null; comment: string | null }][]) => {
      const saved = await world.frankie.patch(`/class-offerings/${offering.id}/term-results`, {
        drafts: drafts.map(([student, content]) => ({ studentPersonId: student.id, loaded: null, ...content })),
      });
      expect(saved.status).toBe(200);
      expect((saved.body as { refusedDrafts: unknown[] }).refusedDrafts).toEqual([]);
    };
    await draft(world.algebra, [
      [world.samPerson, { value: "B", score: 84, comment: "Steady all Term." }],
      [world.skyPerson, { value: "C", score: null, comment: null }],
    ]);
    expect((await world.frankie.post(`/class-offerings/${world.algebra.id}/publications`, {})).status).toBe(201);
    await draft(world.biology, [[world.samPerson, { value: "A", score: null, comment: null }]]);
  }

  it("serves a Student each Class Offering of theirs in a Term with its published result and Attendance totals, and never a draft", async () => {
    const world = await arrange();
    await record(world);

    const report = await read(world.sam, world.samPerson);
    const earlier = await read(world.sam, world.samPerson, world.earlier);

    expect(report.student).toEqual({ id: world.samPerson.id, displayName: "Sam" });
    expect(report.today).toBe(world.today);
    expect(report.shows).toEqual({ termResults: true, attendanceTotals: true });
    // The latest Term first, and the one shown unless another is asked for.
    expect(report.terms.map((term) => term.name)).toEqual(["Current", "Earlier"]);
    expect(report.term?.id).toBe(world.current.id);
    expect(
      report.classOfferings.map(({ id, course, termResult, attendanceTotals }) => [
        id,
        course.name,
        termResult === null || termResult === undefined ? termResult : { ...termResult, publishedAt: typeof termResult.publishedAt },
        attendanceTotals,
      ]),
    ).toEqual([
      [
        world.algebra.id,
        "Algebra I",
        { value: "B", score: 84, comment: "Steady all Term.", publishedAt: "string" },
        // Not recorded: three days ago through today.
        totals({ tardy: 1, not_recorded: 4 }),
      ],
      // The draft A is not shown: none is published yet.
      [world.biology.id, "Biology", null, totals({ present: 1, not_recorded: 4 })],
    ]);
    expect(earlier.term?.id).toBe(world.earlier.id);
    expect(earlier.classOfferings.map(({ id, termResult }) => [id, termResult])).toEqual([[world.history.id, null]]);
    expect(earlier.classOfferings[0]!.attendanceTotals).toEqual(totals({ not_recorded: 36 }));
  });

  it("is still read by the Student once their Enrollment has ended", async () => {
    const world = await arrange();
    await record(world);
    const before = await read(world.sam, world.samPerson);
    const enrollments = (await world.alice.get("/enrollments")).body as {
      enrollments: { id: string; studentPersonId: string }[];
    };
    const enrollment = enrollments.enrollments.find((each) => each.studentPersonId === world.samPerson.id)!;
    expect((await world.alice.delete(`/enrollments/${enrollment.id}`, { reason: "Moved away" })).status).toBe(200);

    const after = await read(world.sam, world.samPerson);

    expect(after.classOfferings.map(({ id, termResult }) => [id, termResult])).toEqual(
      before.classOfferings.map(({ id, termResult }) => [id, termResult]),
    );
  });

  it("is read in full by a School Administrator, and by a Guardian only as far as each link's Access profile grants, with nothing in place of what it withholds", async () => {
    const world = await arrange();
    await record(world);

    const bySam = await read(world.sam, world.samPerson);
    const byAlice = await read(world.alice, world.samPerson);
    const samByGina = await read(world.gina, world.samPerson);
    const skyByGina = await read(world.gina, world.skyPerson);
    const skyByAlice = await read(world.alice, world.skyPerson);

    expect(byAlice).toEqual(bySam);
    expect(samByGina.shows).toEqual({ termResults: true, attendanceTotals: false });
    expect(samByGina.classOfferings).toEqual(bySam.classOfferings.map(({ attendanceTotals: _, ...rest }) => rest));
    expect(skyByGina.shows).toEqual({ termResults: false, attendanceTotals: true });
    expect(skyByGina.classOfferings).toEqual(skyByAlice.classOfferings.map(({ termResult: _, ...rest }) => rest));
    expect(skyByAlice.classOfferings[0]!.termResult?.value).toBe("C");
  });

  it("gives a Guardian whose link grants neither, one whose link has ended, and every other reader the one refusal", async () => {
    const world = await arrange();
    await record(world);
    const refusal = await world.frankie.get(`/persons/${ABSENT_ID}`);
    const attempts: [string, () => Promise<TestResponse>][] = [
      ["a Guardian granted neither", () => world.gus.get(path(world.samPerson))],
      ["another Student", () => world.sky.get(path(world.samPerson))],
      ["Faculty teaching the Student", () => world.frankie.get(path(world.samPerson))],
      ["another School's Administrator", () => world.bob.inSchool(world.schoolId).get(path(world.samPerson))],
      ["a caller with no session", () => server().client.inSchool(world.schoolId).get(path(world.samPerson))],
      ["a Person who does not exist", () => world.alice.get(path({ id: ABSENT_ID }))],
      [
        "a Guardian whose link has ended",
        async () => {
          const ended = await world.alice.delete(`/guardian-links/${world.ginaSamLinkId}`, { reason: "No longer a Guardian" });
          expect(ended.status).toBe(200);
          return world.gina.get(path(world.samPerson));
        },
      ],
    ];

    const answered: string[] = [];
    for (const [what, attempt] of attempts) {
      const response = await attempt();
      if (!isDeepStrictEqual(observable(response), observable(refusal))) {
        answered.push(`${what} answered ${response.status}`);
      }
    }

    expect(answered).toEqual([]);
    // The other linked Student stands on their own link.
    expect((await world.gina.get(path(world.skyPerson))).status).toBe(200);
  });

  it("refuses a Term the Student was not rostered in as an invalid request, and serves none for a Student rostered nowhere", async () => {
    const world = await arrange();

    const skyEarlier = await world.alice.get(path(world.skyPerson, world.earlier));
    const absentTerm = await world.alice.get(path(world.skyPerson, { id: ABSENT_ID }));

    expect(skyEarlier.status).toBe(400);
    expect(absentTerm.status).toBe(400);
    expect(absentTerm.body).toEqual(skyEarlier.body);
    const persons = (await world.alice.get("/persons")).body as { persons: { id: string; displayName: string }[] };
    const frankie = persons.persons.find((each) => each.displayName === "Frankie")!;
    const nowhere = (await world.alice.get(path(frankie))).body as { termReport: TermReport };
    expect(nowhere.termReport.terms).toEqual([]);
    expect(nowhere.termReport.term).toBeNull();
    expect(nowhere.termReport.classOfferings).toEqual([]);
  });
});
