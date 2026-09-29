import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import type { Person } from "../src/identity/index.ts";
import { observable, useTestServer, type TestClient, type TestResponse } from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const BOB = { username: "bob", password: "yet another staple, longer" };
const FRANKIE = { username: "frankie", password: "a faculty member's staple" };
const COREY = { username: "corey", password: "a co-teacher's staple, too" };
const DANA = { username: "dana", password: "a never assigned staple" };
const ELLIS = { username: "ellis", password: "a former teacher's staple" };
const SAM = { username: "sam", password: "a student's staple, first" };
const GINA = { username: "gina", password: "a guardian's staple, twice over" };
const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

interface Named {
  id: string;
  displayName: string;
}

interface Content {
  value: string | null;
  score: number | null;
  comment: string | null;
}

interface TermResult extends Content {
  scaleVersion: number | null;
  recordedBy: Named;
  recordedAt: string;
}

interface OfferingResults {
  classOfferingId: string;
  readOnlyBecause: "not_teaching" | null;
  resultValueScale: { version: number; values: { label: string; description: string | null }[] };
  students: {
    person: Named;
    rosterMemberships: { firstDate: string; lastDate: string | null }[];
    termResult: TermResult | null;
  }[];
}

interface RefusedDraft {
  studentPersonId: string;
  because: "stale" | "value_not_in_scale";
  termResult: TermResult | null;
}

interface Recorded {
  actorPersonId: string | null;
  action: string;
  target: { type: string; id: string | null };
  before: unknown;
  after: unknown;
}

const NOTHING: Content = { value: null, score: null, comment: null };

/** The School date `days` after this one, which may be negative. */
function shifted(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

describe("draft Term results", () => {
  const server = useTestServer();

  interface World {
    schoolId: string;
    /** Alice: Northside's School Administrator. */
    alice: TestClient;
    /** Bob: Westbrook's School Administrator, and nothing at Northside. */
    bob: TestClient;
    /** Frankie and Corey: Faculty teaching the offering all Term. */
    frankie: TestClient;
    frankiePerson: Person;
    corey: TestClient;
    coreyPerson: Person;
    /** Dana: Faculty never assigned to the offering. */
    dana: TestClient;
    /** Ellis: Faculty whose assignment to the offering ended yesterday. */
    ellis: TestClient;
    /** Sam: rostered all Term. Lee: withdrew after the Term's first three days. Nia: enrolled, never rostered. */
    sam: TestClient;
    samPerson: Person;
    leePerson: Person;
    niaPerson: Person;
    /** Gina: Sam's Guardian, with results read. */
    gina: TestClient;
    today: string;
    offering: { id: string };
  }

  /** Northside's one Term runs from nine days ago to ten days on. */
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
    const corey = await person(COREY, "Corey", "faculty");
    const dana = await person(DANA, "Dana", "faculty");
    const ellis = await person(ELLIS, "Ellis", "faculty");
    for (const [faculty, bounds] of [
      [frankie.person, {}],
      [corey.person, {}],
      [ellis.person, { firstDate: shifted(today, -9), lastDate: shifted(today, -1) }],
    ] as const) {
      const assigned = await alice.post(`/class-offerings/${offering.id}/teaching-assignments`, { personId: faculty.id, ...bounds });
      expect(assigned.status).toBe(201);
    }
    const sam = await person(SAM, "Sam", "student");
    const lee = await person(null, "Lee", "student");
    const nia = await person(null, "Nia", "student");
    for (const student of [sam.person, lee.person, nia.person]) {
      await server().enroll(student);
    }
    for (const [student, bounds] of [
      [sam.person, {}],
      [lee.person, { firstDate: shifted(today, -9), lastDate: shifted(today, -7) }],
    ] as const) {
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
      corey: corey.client!,
      coreyPerson: corey.person,
      dana: dana.client!,
      ellis: ellis.client!,
      sam: sam.client!,
      samPerson: sam.person,
      leePerson: lee.person,
      niaPerson: nia.person,
      gina: gina.client!,
      today,
      offering,
    };
  }

  const path = (world: World) => `/class-offerings/${world.offering.id}/term-results`;

  async function read(world: World, as: TestClient): Promise<OfferingResults> {
    const response = await as.get(path(world));
    expect(response.status).toBe(200);
    return (response.body as { classOfferingResults: OfferingResults }).classOfferingResults;
  }

  /** The content a reader was served for this Student, as a save carries it back. */
  function loadedFor(results: OfferingResults, student: Person): Content | null {
    const held = results.students.find((each) => each.person.id === student.id)?.termResult ?? null;
    return held === null ? null : { value: held.value, score: held.score, comment: held.comment };
  }

  function save(world: World, as: TestClient, drafts: ({ studentPersonId: string; loaded: Content | null } & Content)[]) {
    return as.patch(path(world), { drafts });
  }

  /** Saves these drafts, each carrying what the reader loaded now, and expects every one to apply. */
  async function record(world: World, as: TestClient, drafts: [Person, Content][]): Promise<OfferingResults> {
    const loaded = await read(world, as);
    const saved = await save(
      world,
      as,
      drafts.map(([student, content]) => ({ studentPersonId: student.id, loaded: loadedFor(loaded, student), ...content })),
    );
    expect(saved.status).toBe(200);
    expect((saved.body as { refusedDrafts: RefusedDraft[] }).refusedDrafts).toEqual([]);
    return (saved.body as { classOfferingResults: OfferingResults }).classOfferingResults;
  }

  function resultOf(results: OfferingResults, student: Person): TermResult | null {
    return results.students.find((each) => each.person.id === student.id)!.termResult;
  }

  async function trailOf(world: World): Promise<Recorded[]> {
    const response = await world.alice.get("/audit-records");
    expect(response.status).toBe(200);
    return (response.body as { auditRecords: Recorded[] }).auditRecords.filter((each) => each.action.startsWith("term_result."));
  }

  it("records a value, score and comment for every roster member, a withdrawn one included, and saves with some left without a value", async () => {
    const world = await arrange();
    const { samPerson: sam, leePerson: lee } = world;

    const saved = await record(world, world.frankie, [
      [sam, { value: "A", score: 91.5, comment: "Steady, careful work all Term." }],
      [lee, { value: null, score: null, comment: "Left before the first test." }],
    ]);

    expect(saved).toEqual(await read(world, world.frankie));
    expect(saved.classOfferingId).toBe(world.offering.id);
    expect(saved.readOnlyBecause).toBeNull();
    expect(saved.resultValueScale.version).toBe(1);
    expect(saved.students.map(({ person, rosterMemberships }) => [person, rosterMemberships])).toEqual([
      [{ id: lee.id, displayName: "Lee" }, [{ firstDate: shifted(world.today, -9), lastDate: shifted(world.today, -7) }]],
      [{ id: sam.id, displayName: "Sam" }, [{ firstDate: shifted(world.today, -9), lastDate: null }]],
    ]);
    const frankie = { id: world.frankiePerson.id, displayName: "Frankie" };
    expect(resultOf(saved, sam)).toEqual({
      value: "A",
      scaleVersion: 1,
      score: 91.5,
      comment: "Steady, careful work all Term.",
      recordedBy: frankie,
      recordedAt: expect.any(String),
    });
    expect(resultOf(saved, lee)).toEqual({
      value: null,
      scaleVersion: null,
      score: null,
      comment: "Left before the first test.",
      recordedBy: frankie,
      recordedAt: expect.any(String),
    });
  });

  it("holds a score to 0 to 100 with one decimal and a comment to 500 characters, refusing anything else whole", async () => {
    const world = await arrange();
    const sam = world.samPerson;
    const draft = (content: Partial<Content>) => [{ studentPersonId: sam.id, loaded: null, ...NOTHING, ...content }];

    for (const [what, body] of [
      ["a score below 0", { drafts: draft({ score: -0.1 }) }],
      ["a score above 100", { drafts: draft({ score: 100.1 }) }],
      ["a score with two decimals", { drafts: draft({ score: 87.25 }) }],
      ["a score given as text", { drafts: draft({ score: "87" as unknown as number }) }],
      ["a comment over 500 characters", { drafts: draft({ comment: "x".repeat(501) }) }],
      ["a blank comment", { drafts: draft({ comment: "   " }) }],
      ["a draft missing its score", { drafts: [{ studentPersonId: sam.id, loaded: null, value: "A", comment: null }] }],
      ["a Student named twice", { drafts: [...draft({ value: "A" }), ...draft({ value: "B" })] }],
      ["a Student never rostered", { drafts: [{ studentPersonId: world.niaPerson.id, loaded: null, ...NOTHING, value: "A" }] }],
      ["a Person who does not exist", { drafts: [{ studentPersonId: ABSENT_ID, loaded: null, ...NOTHING, value: "A" }] }],
      ["drafts that are not a list", { drafts: "A" }],
    ] as const) {
      const response = await world.frankie.patch(path(world), body);
      expect(response.status, what).toBe(400);
    }
    expect(resultOf(await read(world, world.frankie), sam)).toBeNull();

    const bounds = await record(world, world.frankie, [[sam, { value: null, score: 100, comment: "x".repeat(500) }]]);
    expect(resultOf(bounds, sam)).toMatchObject({ score: 100, comment: "x".repeat(500) });
    const lowest = await record(world, world.frankie, [[sam, { value: null, score: 0, comment: null }]]);
    expect(resultOf(lowest, sam)).toMatchObject({ score: 0, comment: null });
  });

  it("refuses a value the current scale does not hold, with its current content, while the rest apply", async () => {
    const world = await arrange();
    const { samPerson: sam, leePerson: lee } = world;

    const saved = await save(world, world.frankie, [
      { studentPersonId: sam.id, loaded: null, ...NOTHING, value: "E" },
      { studentPersonId: lee.id, loaded: null, ...NOTHING, value: "B" },
    ]);

    expect(saved.status).toBe(200);
    const { classOfferingResults, refusedDrafts } = saved.body as { classOfferingResults: OfferingResults; refusedDrafts: RefusedDraft[] };
    expect(refusedDrafts).toEqual([{ studentPersonId: sam.id, because: "value_not_in_scale", termResult: null }]);
    expect(resultOf(classOfferingResults, sam)).toBeNull();
    expect(resultOf(classOfferingResults, lee)?.value).toBe("B");
    // Letter case counts: the scale's label is B.
    const lowered = await save(world, world.frankie, [
      { studentPersonId: sam.id, loaded: null, ...NOTHING, value: "b" },
    ]);
    expect((lowered.body as { refusedDrafts: RefusedDraft[] }).refusedDrafts).toMatchObject([{ because: "value_not_in_scale" }]);
  });

  it("binds a changed value to the scale version then in force, and leaves an untouched value on its own", async () => {
    const world = await arrange();
    const { samPerson: sam, leePerson: lee } = world;
    await record(world, world.frankie, [
      [sam, { value: "A", score: null, comment: null }],
      [lee, { value: "F", score: null, comment: null }],
    ]);
    // Version 2 has no F.
    const scaled = await world.alice.post("/result-value-scale", {
      values: ["A", "B", "C", "D", "E"].map((label) => ({ label, description: null })),
    });
    expect(scaled.status).toBe(201);

    const saved = await record(world, world.frankie, [
      [sam, { value: "B", score: null, comment: null }],
      [lee, { value: "F", score: 40, comment: "Withdrew." }],
    ]);

    expect(resultOf(saved, sam)).toMatchObject({ value: "B", scaleVersion: 2 });
    expect(resultOf(saved, lee)).toMatchObject({ value: "F", scaleVersion: 1, score: 40, comment: "Withdrew." });
    expect(saved.resultValueScale.version).toBe(2);
    // Changed back to a label both versions hold, it is bound to the current one.
    const again = await record(world, world.frankie, [[sam, { value: "A", score: null, comment: null }]]);
    expect(resultOf(again, sam)).toMatchObject({ value: "A", scaleVersion: 2 });
  });

  it("refuses a draft a co-teacher changed since it was loaded, returning its current content, while the rest of the save applies", async () => {
    const world = await arrange();
    const { samPerson: sam, leePerson: lee } = world;
    await record(world, world.frankie, [[sam, { value: "B", score: 80, comment: null }]]);
    const loaded = await read(world, world.frankie);
    // Corey changes Sam's draft and gives Lee a first one after Frankie loaded the class.
    await record(world, world.corey, [
      [sam, { value: "B", score: 82, comment: null }],
      [lee, { value: "C", score: null, comment: null }],
    ]);

    const saved = await save(world, world.frankie, [
      { studentPersonId: sam.id, loaded: loadedFor(loaded, sam), value: "A", score: 80, comment: null },
      { studentPersonId: lee.id, loaded: loadedFor(loaded, lee), value: "D", score: null, comment: null },
    ]);

    expect(saved.status).toBe(200);
    const { classOfferingResults, refusedDrafts } = saved.body as { classOfferingResults: OfferingResults; refusedDrafts: RefusedDraft[] };
    const corey = { id: world.coreyPerson.id, displayName: "Corey" };
    expect(refusedDrafts).toEqual([
      {
        studentPersonId: sam.id,
        because: "stale",
        termResult: { value: "B", scaleVersion: 1, score: 82, comment: null, recordedBy: corey, recordedAt: expect.any(String) },
      },
      {
        studentPersonId: lee.id,
        because: "stale",
        termResult: { value: "C", scaleVersion: 1, score: null, comment: null, recordedBy: corey, recordedAt: expect.any(String) },
      },
    ]);
    expect(resultOf(classOfferingResults, sam)).toMatchObject({ value: "B", score: 82, recordedBy: corey });

    // One stale draft leaves the rest to apply.
    const mixed = await save(world, world.frankie, [
      { studentPersonId: sam.id, loaded: loadedFor(loaded, sam), value: "A", score: 80, comment: null },
      { studentPersonId: lee.id, loaded: loadedFor(classOfferingResults, lee), value: "D", score: null, comment: null },
    ]);
    expect((mixed.body as { refusedDrafts: RefusedDraft[] }).refusedDrafts.map((each) => each.studentPersonId)).toEqual([sam.id]);
    expect(resultOf((mixed.body as { classOfferingResults: OfferingResults }).classOfferingResults, lee)?.value).toBe("D");
  });

  it("audits a change to an existing draft with its before and after values, and neither a first draft nor a save that changes nothing", async () => {
    const world = await arrange();
    const sam = world.samPerson;
    await record(world, world.frankie, [[sam, { value: "B", score: 80, comment: null }]]);
    expect(await trailOf(world)).toEqual([]);
    await record(world, world.frankie, [[sam, { value: "B", score: 80, comment: null }]]);
    expect(await trailOf(world)).toEqual([]);

    const saved = await record(world, world.corey, [[sam, { value: "A", score: 80, comment: "Much improved." }]]);

    const facts = { studentPersonId: sam.id, classOfferingId: world.offering.id };
    expect(await trailOf(world)).toEqual([
      expect.objectContaining({
        actorPersonId: world.coreyPerson.id,
        action: "term_result.changed",
        target: { type: "term_result", id: expect.any(String) },
        before: { ...facts, value: "B", scaleVersion: 1, score: 80, comment: null },
        after: { ...facts, value: "A", scaleVersion: 1, score: 80, comment: "Much improved." },
      }),
    ]);
    expect(resultOf(saved, sam)?.recordedBy.id).toBe(world.coreyPerson.id);
  });

  it("is read alike by Faculty ever assigned and the School Administrator, read-only for those without an active assignment", async () => {
    const world = await arrange();
    await record(world, world.frankie, [[world.samPerson, { value: "C", score: 70, comment: null }]]);

    const byFrankie = await read(world, world.frankie);
    const byEllis = await read(world, world.ellis);
    const byAlice = await read(world, world.alice);

    expect(byFrankie.readOnlyBecause).toBeNull();
    expect(byEllis).toEqual({ ...byFrankie, readOnlyBecause: "not_teaching" });
    expect(byAlice).toEqual({ ...byFrankie, readOnlyBecause: "not_teaching" });
  });

  it("gives every caller who may not read or record drafts the one refusal", async () => {
    const world = await arrange();
    await record(world, world.frankie, [[world.samPerson, { value: "C", score: null, comment: null }]]);
    const refusal = await world.frankie.get(`/persons/${ABSENT_ID}`);
    const draft = { drafts: [{ studentPersonId: world.samPerson.id, loaded: null, ...NOTHING, value: "A" }] };
    const attempts: [string, () => Promise<TestResponse>][] = [
      ["Faculty never assigned reading", () => world.dana.get(path(world))],
      ["a Student rostered in it reading", () => world.sam.get(path(world))],
      ["a Guardian with results read reading", () => world.gina.get(path(world))],
      ["another School's Administrator reading", () => world.bob.inSchool(world.schoolId).get(path(world))],
      ["a caller with no session reading", () => server().client.inSchool(world.schoolId).get(path(world))],
      ["reading an offering that does not exist", () => world.frankie.get(`/class-offerings/${ABSENT_ID}/term-results`)],
      ["Faculty whose assignment has ended saving", () => world.ellis.patch(path(world), draft)],
      ["the School Administrator saving", () => world.alice.patch(path(world), draft)],
      ["Faculty never assigned saving", () => world.dana.patch(path(world), draft)],
      ["a Student saving", () => world.sam.patch(path(world), draft)],
      ["a Guardian saving", () => world.gina.patch(path(world), draft)],
      ["saving to an offering that does not exist", () => world.frankie.patch(`/class-offerings/${ABSENT_ID}/term-results`, draft)],
      ["Faculty whose assignment has ended saving a malformed body", () => world.ellis.patch(path(world), { drafts: "A" })],
    ];

    const answered: string[] = [];
    for (const [what, attempt] of attempts) {
      const response = await attempt();
      if (!isDeepStrictEqual(observable(response), observable(refusal))) {
        answered.push(`${what} answered ${response.status}`);
      }
    }

    expect(answered).toEqual([]);
    expect(resultOf(await read(world, world.frankie), world.samPerson)?.value).toBe("C");
  });
});
