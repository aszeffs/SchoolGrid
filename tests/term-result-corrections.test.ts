import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import type { Person } from "../src/identity/index.ts";
import { observable, useTestServer, type TestClient, type TestResponse } from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const AVERY = { username: "avery", password: "a second administrator's staple" };
const BOB = { username: "bob", password: "yet another staple, longer" };
const FRANKIE = { username: "frankie", password: "a faculty member's staple" };
const ELLIS = { username: "ellis", password: "a former teacher's staple" };
const SAM = { username: "sam", password: "a student's staple, first" };
const GINA = { username: "gina", password: "a guardian's staple, twice over" };
const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

interface Named {
  id: string;
  displayName: string;
}

interface Content {
  value: string;
  score: number | null;
  comment: string | null;
}

interface CorrectionRequest {
  id: string;
  kind: "term_result";
  state: "pending" | "approved" | "rejected" | "withdrawn";
  student: Named;
  classOffering: { id: string; course: { name: string } };
  before: Content;
  after: Content;
  reason: string;
  requestedBy: Named;
  raisedAt: string;
  decidedBy: Named | null;
  decidedAt: string | null;
  rejectionReason: string | null;
  selfApproved: boolean;
}

interface Stored extends Content {
  scaleVersion: number;
  recordedBy: Named;
  publishedAt: string | null;
}

interface Recorded {
  actorPersonId: string | null;
  action: string;
  target: { type: string; id: string | null };
  reason: string | null;
  before: unknown;
  after: unknown;
}

const LETTERS = ["A", "B", "C", "D", "F"].map((label) => ({ label, description: null }));

/** The School date `days` after this one, which may be negative. */
function shifted(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

describe("Correction requests for Term results", () => {
  const server = useTestServer();

  interface World {
    schoolId: string;
    /** Alice and Avery: Northside's two School Administrators. */
    alice: TestClient;
    alicePerson: Person;
    avery: TestClient;
    averyPerson: Person;
    /** Bob: Westbrook's School Administrator, and nothing at Northside. */
    bob: TestClient;
    /** Frankie: Faculty teaching the offering all Term. */
    frankie: TestClient;
    frankiePerson: Person;
    /** Ellis: Faculty whose assignment to the offering ended yesterday. */
    ellis: TestClient;
    /** Sam: published B, 81.5, "Steady work". Sky: published C, no score or comment. */
    sam: TestClient;
    samPerson: Person;
    skyPerson: Person;
    /** Lee: left the roster early, with a draft D given after the Publication. */
    leePerson: Person;
    /** Gina: Sam's Guardian, with results read. */
    gina: TestClient;
    offering: { id: string };
  }

  /** Northside's one Term runs from nine days ago to ten days on, with Sam's and Sky's results published. */
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
    const { academicYear } = year.body as { academicYear: { id: string } };
    const divided = await alice.patch(`/academic-years/${academicYear.id}`, {
      terms: [{ name: "Short", firstDate: shifted(today, -9), lastDate: shifted(today, 10) }],
    });
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
      role: "faculty" | "student" | "guardian" | "school_administrator",
    ) => {
      const account = credentials === null ? undefined : await server().createAccount(credentials);
      const created = await server().createPerson({ schoolId, displayName, role, ...(account === undefined ? {} : { account }) });
      return { person: created, client: account === undefined ? null : (await server().sessionFor(account)).inSchool(schoolId) };
    };
    const avery = await person(AVERY, "Avery", "school_administrator");
    const frankie = await person(FRANKIE, "Frankie", "faculty");
    const ellis = await person(ELLIS, "Ellis", "faculty");
    for (const [faculty, bounds] of [
      [frankie.person, {}],
      [ellis.person, { firstDate: shifted(today, -9), lastDate: shifted(today, -1) }],
    ] as const) {
      const assigned = await alice.post(`/class-offerings/${offering.id}/teaching-assignments`, { personId: faculty.id, ...bounds });
      expect(assigned.status).toBe(201);
    }
    const sam = await person(SAM, "Sam", "student");
    const sky = await person(null, "Sky", "student");
    const lee = await person(null, "Lee", "student");
    for (const student of [sam.person, sky.person, lee.person]) {
      await server().enroll(student);
    }
    for (const [personIds, bounds] of [
      [[sam.person.id, sky.person.id], {}],
      [[lee.person.id], { firstDate: shifted(today, -9), lastDate: shifted(today, -7) }],
    ] as const) {
      expect((await alice.post(`/class-offerings/${offering.id}/roster-memberships`, { personIds, ...bounds })).status).toBe(201);
    }
    const gina = await person(GINA, "Gina", "guardian");
    await alice.post("/guardian-links", {
      guardianPersonId: gina.person.id,
      studentPersonId: sam.person.id,
      accessProfile: { attendanceRead: true, resultsRead: true },
    });

    const resultsPath = `/class-offerings/${offering.id}/term-results`;
    const saved = await frankie.client!.patch(resultsPath, {
      drafts: [
        { studentPersonId: sam.person.id, loaded: null, value: "B", score: 81.5, comment: "Steady work" },
        { studentPersonId: sky.person.id, loaded: null, value: "C", score: null, comment: null },
      ],
    });
    expect(saved.status).toBe(200);
    expect((await frankie.client!.post(`/class-offerings/${offering.id}/publications`, {})).status).toBe(201);
    const drafted = await frankie.client!.patch(resultsPath, {
      drafts: [{ studentPersonId: lee.person.id, loaded: null, value: "D", score: null, comment: null }],
    });
    expect(drafted.status).toBe(200);

    return {
      schoolId,
      alice,
      alicePerson: northside.schoolAdministrator,
      avery: avery.client!,
      averyPerson: avery.person,
      bob: (await server().sessionFor(bobAccount)).inSchool(westbrook.school.id),
      frankie: frankie.client!,
      frankiePerson: frankie.person,
      ellis: ellis.client!,
      sam: sam.client!,
      samPerson: sam.person,
      skyPerson: sky.person,
      leePerson: lee.person,
      gina: gina.client!,
      offering,
    };
  }

  interface Raise {
    studentPersonId: string;
    after: { value: string | null; score: number | null; comment: string | null };
    reason?: string;
  }

  function raise(world: World, as: TestClient, { reason = "Marked against the wrong paper", ...target }: Raise): Promise<TestResponse> {
    return as.post(`/class-offerings/${world.offering.id}/correction-requests`, { kind: "term_result", reason, ...target });
  }

  async function raised(world: World, as: TestClient, target: Raise): Promise<CorrectionRequest> {
    const response = await raise(world, as, target);
    expect(response.status).toBe(201);
    return (response.body as { correctionRequest: CorrectionRequest }).correctionRequest;
  }

  function decide(as: TestClient, request: { id: string }, state: "approved" | "rejected", reason?: string) {
    return as.patch(`/correction-requests/${request.id}`, { state, ...(reason === undefined ? {} : { reason }) });
  }

  /** Each Student's stored result in the offering, by display name. */
  async function resultsOf(world: World): Promise<Record<string, Stored | null>> {
    const response = await world.alice.get(`/class-offerings/${world.offering.id}/term-results`);
    expect(response.status).toBe(200);
    const { students } = (response.body as { classOfferingResults: { students: { person: Named; termResult: Stored | null }[] } })
      .classOfferingResults;
    return Object.fromEntries(students.map((student) => [student.person.displayName, student.termResult]));
  }

  async function trailOf(admin: TestClient, prefix: string): Promise<Recorded[]> {
    const response = await admin.get("/audit-records");
    expect(response.status).toBe(200);
    return (response.body as { auditRecords: Recorded[] }).auditRecords.filter((record) => record.action.startsWith(prefix));
  }

  function conflictOf(response: TestResponse) {
    return { status: response.status, body: response.body };
  }

  const SAM_BEFORE = { value: "B", score: 81.5, comment: "Steady work" };

  it("is raised for a published result by Faculty teaching the offering or a School Administrator, changing any of its value, score and comment", async () => {
    const world = await arrange();

    const scoreOnly = await raised(world, world.frankie, { studentPersonId: world.samPerson.id, after: { ...SAM_BEFORE, score: 85 } });
    const everything = await raised(world, world.alice, {
      studentPersonId: world.skyPerson.id,
      after: { value: "B", score: 77, comment: "Resubmitted coursework" },
      reason: "Coursework found",
    });

    expect(scoreOnly).toEqual({
      id: expect.any(String),
      kind: "term_result",
      state: "pending",
      student: { id: world.samPerson.id, displayName: "Sam" },
      classOffering: expect.objectContaining({ id: world.offering.id, course: expect.objectContaining({ name: "Algebra I" }) }),
      before: SAM_BEFORE,
      after: { ...SAM_BEFORE, score: 85 },
      reason: "Marked against the wrong paper",
      requestedBy: { id: world.frankiePerson.id, displayName: "Frankie" },
      raisedAt: expect.any(String),
      decidedBy: null,
      decidedAt: null,
      rejectionReason: null,
      selfApproved: false,
    });
    expect(everything).toEqual(
      expect.objectContaining({
        before: { value: "C", score: null, comment: null },
        after: { value: "B", score: 77, comment: "Resubmitted coursework" },
        requestedBy: { id: world.alicePerson.id, displayName: world.alicePerson.displayName },
      }),
    );
    // Raising changes no result.
    const results = await resultsOf(world);
    expect(results["Sam"]).toEqual(expect.objectContaining(SAM_BEFORE));
    expect(results["Sky"]).toEqual(expect.objectContaining({ value: "C", score: null, comment: null }));
    const listed = (await world.alice.get("/correction-requests")).body as { correctionRequests: CorrectionRequest[] };
    expect(listed.correctionRequests.map((request) => [request.kind, request.id])).toEqual([
      ["term_result", scoreOnly.id],
      ["term_result", everything.id],
    ]);
    expect(await trailOf(world.alice, "correction_request.")).toEqual([
      expect.objectContaining({
        action: "correction_request.raised",
        actorPersonId: world.alicePerson.id,
        target: { type: "correction_request", id: everything.id },
        reason: "Coursework found",
        before: null,
        after: expect.objectContaining({
          kind: "term_result",
          state: "pending",
          beforeValue: "C",
          beforeScore: null,
          beforeComment: null,
          afterValue: "B",
          afterScore: 77,
          afterComment: "Resubmitted coursework",
        }),
      }),
      expect.objectContaining({ action: "correction_request.raised", target: { type: "correction_request", id: scoreOnly.id } }),
    ]);
  });

  it("is refused for a draft or missing result, a change to nothing, or a value off the current scale, and for anyone but who may raise it", async () => {
    const world = await arrange();
    const refusal = await world.frankie.get(`/persons/${ABSENT_ID}`);

    const conflicts: [string, Raise, string][] = [
      ["a draft", { studentPersonId: world.leePerson.id, after: { value: "C", score: null, comment: null } }, "not_published"],
      ["a Student with no result", { studentPersonId: ABSENT_ID, after: { value: "C", score: null, comment: null } }, "not_published"],
      ["the content it already holds", { studentPersonId: world.samPerson.id, after: SAM_BEFORE }, "unchanged"],
      ["a value off the scale", { studentPersonId: world.samPerson.id, after: { ...SAM_BEFORE, value: "Z" } }, "value_not_in_scale"],
    ];
    const answered: string[] = [];
    for (const [what, target, conflict] of conflicts) {
      const response = await raise(world, world.frankie, target);
      if (!isDeepStrictEqual(conflictOf(response), { status: 409, body: { status: "conflict", conflict } })) {
        answered.push(`${what} answered ${response.status} ${JSON.stringify(response.body)}`);
      }
    }
    const invalid: [string, unknown][] = [
      ["no value", { kind: "term_result", studentPersonId: world.samPerson.id, after: { ...SAM_BEFORE, value: null }, reason: "x" }],
      ["a score above 100", { kind: "term_result", studentPersonId: world.samPerson.id, after: { ...SAM_BEFORE, score: 100.5 }, reason: "x" }],
      ["no reason", { kind: "term_result", studentPersonId: world.samPerson.id, after: { ...SAM_BEFORE, score: 85 } }],
      ["a date", { kind: "term_result", studentPersonId: world.samPerson.id, date: "2026-01-01", after: { ...SAM_BEFORE, score: 85 }, reason: "x" }],
    ];
    for (const [what, body] of invalid) {
      const response = await world.frankie.post(`/class-offerings/${world.offering.id}/correction-requests`, body);
      if (response.status !== 400) {
        answered.push(`${what} answered ${response.status}`);
      }
    }
    const target = { studentPersonId: world.samPerson.id, after: { ...SAM_BEFORE, score: 85 } };
    const refused: [string, () => Promise<TestResponse>][] = [
      ["a former teacher", () => raise(world, world.ellis, target)],
      ["a Student", () => raise(world, world.sam, target)],
      ["a Guardian", () => raise(world, world.gina, target)],
      ["another School's Administrator", () => raise(world, world.bob.inSchool(world.schoolId), target)],
      [
        "an offering that does not exist",
        () => world.alice.post(`/class-offerings/${ABSENT_ID}/correction-requests`, { kind: "term_result", ...target, reason: "x" }),
      ],
    ];
    for (const [what, attempt] of refused) {
      const response = await attempt();
      if (!isDeepStrictEqual(observable(response), observable(refusal))) {
        answered.push(`${what} answered ${response.status}`);
      }
    }

    expect(answered).toEqual([]);
    const { rows } = await server().ownerDatabase.query(`SELECT count(*)::int AS count FROM app.correction_request`);
    expect(rows).toEqual([{ count: 0 }]);
  });

  it("is approved by another School Administrator, applying the change at once, a changed value bound to the current version, and audited", async () => {
    const world = await arrange();
    // The School adds a value; B stays on the scale, now in version 2.
    expect((await world.alice.post("/result-value-scale", { values: [...LETTERS, { label: "P", description: "Pass" }] })).status).toBe(201);
    const valueChange = await raised(world, world.frankie, { studentPersonId: world.samPerson.id, after: { ...SAM_BEFORE, value: "A" } });
    const scoreChange = await raised(world, world.frankie, {
      studentPersonId: world.skyPerson.id,
      after: { value: "C", score: 70, comment: null },
      reason: "Score left off",
    });
    const before = await resultsOf(world);

    const approved = await decide(world.alice, valueChange, "approved");
    const alsoApproved = await decide(world.avery, scoreChange, "approved");

    expect(approved.status).toBe(200);
    expect(alsoApproved.status).toBe(200);
    expect((approved.body as { correctionRequest: CorrectionRequest }).correctionRequest).toEqual(
      expect.objectContaining({
        state: "approved",
        decidedBy: { id: world.alicePerson.id, displayName: world.alicePerson.displayName },
        selfApproved: false,
      }),
    );
    const after = await resultsOf(world);
    expect(after["Sam"]).toEqual(
      expect.objectContaining({
        ...SAM_BEFORE,
        value: "A",
        scaleVersion: 2,
        recordedBy: { id: world.alicePerson.id, displayName: world.alicePerson.displayName },
        publishedAt: before["Sam"]!.publishedAt,
      }),
    );
    // A value left as it was keeps its version.
    expect(after["Sky"]).toEqual(expect.objectContaining({ value: "C", score: 70, scaleVersion: 1, publishedAt: before["Sky"]!.publishedAt }));
    // The Student sees it on their Term report at once.
    const report = await world.sam.get(`/persons/${world.samPerson.id}/term-report`);
    expect(report.status).toBe(200);
    const [shown] = (report.body as { termReport: { classOfferings: { termResult: Content | null }[] } }).termReport.classOfferings;
    expect(shown!.termResult).toEqual(expect.objectContaining({ ...SAM_BEFORE, value: "A" }));
    expect(await trailOf(world.alice, "correction_request.approved")).toEqual([
      expect.objectContaining({
        actorPersonId: world.averyPerson.id,
        target: { type: "correction_request", id: scoreChange.id },
        before: expect.objectContaining({ state: "pending", beforeScore: null, afterScore: 70 }),
        after: expect.objectContaining({ state: "approved", selfApproved: false }),
      }),
      expect.objectContaining({ actorPersonId: world.alicePerson.id, target: { type: "correction_request", id: valueChange.id } }),
    ]);
    expect(await trailOf(world.alice, "term_result.changed")).toEqual([
      expect.objectContaining({
        actorPersonId: world.averyPerson.id,
        reason: "Score left off",
        before: expect.objectContaining({ studentPersonId: world.skyPerson.id, score: null, scaleVersion: 1 }),
        after: expect.objectContaining({ studentPersonId: world.skyPerson.id, score: 70, scaleVersion: 1 }),
      }),
      expect.objectContaining({
        actorPersonId: world.alicePerson.id,
        reason: "Marked against the wrong paper",
        before: expect.objectContaining({ value: "B", scaleVersion: 1 }),
        after: expect.objectContaining({ value: "A", scaleVersion: 2 }),
      }),
    ]);
  });

  it("refuses approval once any of value, score or comment has changed, or its new value has left the scale, and a rejection changes nothing", async () => {
    const world = await arrange();
    const owner = server().ownerDatabase;
    const { rows: values } = await owner.query<{ id: string }>(
      `SELECT value.id FROM app.result_value value WHERE value.school_id = $1 AND value.label = 'A'`,
      [world.schoolId],
    );
    // Each part in turn changed behind the request, then put back.
    const parts: [string, string, unknown[]][] = [
      ["value", `result_value_id = $3`, [values[0]!.id]],
      ["score", `score = 90`, []],
      ["comment", `comment = 'Rewritten'`, []],
    ];
    const answered: string[] = [];
    for (const [part, change, parameters] of parts) {
      const request = await raised(world, world.frankie, { studentPersonId: world.samPerson.id, after: { ...SAM_BEFORE, score: 85 } });
      const { rows } = await owner.query<{ id: string; resultValueId: string; score: string; comment: string }>(
        `SELECT id, result_value_id AS "resultValueId", score, comment FROM app.term_result
         WHERE school_id = $1 AND student_person_id = $2`,
        [world.schoolId, world.samPerson.id],
      );
      const stored = rows[0]!;
      await owner.query(`UPDATE app.term_result SET ${change} WHERE school_id = $1 AND id = $2`, [world.schoolId, stored.id, ...parameters]);
      const response = await decide(world.alice, request, "approved");
      if (!isDeepStrictEqual(conflictOf(response), { status: 409, body: { status: "conflict", conflict: "target_changed" } })) {
        answered.push(`a changed ${part} answered ${response.status} ${JSON.stringify(response.body)}`);
      }
      await owner.query(`UPDATE app.term_result SET result_value_id = $3, score = $4, comment = $5 WHERE school_id = $1 AND id = $2`, [
        world.schoolId,
        stored.id,
        stored.resultValueId,
        stored.score,
        stored.comment,
      ]);
    }
    // D leaves the scale after the request to give it was raised.
    const toD = await raised(world, world.frankie, { studentPersonId: world.skyPerson.id, after: { value: "D", score: null, comment: null } });
    expect((await world.alice.post("/result-value-scale", { values: LETTERS.filter((value) => value.label !== "D") })).status).toBe(201);
    const offScale = await decide(world.alice, toD, "approved");
    const rejected = await decide(world.alice, toD, "rejected", "D is no longer given");

    expect(answered).toEqual([]);
    expect(conflictOf(offScale)).toEqual({ status: 409, body: { status: "conflict", conflict: "value_not_in_scale" } });
    expect(rejected.status).toBe(200);
    const results = await resultsOf(world);
    expect(results["Sam"]).toEqual(expect.objectContaining(SAM_BEFORE));
    expect(results["Sky"]).toEqual(expect.objectContaining({ value: "C", scaleVersion: 1 }));
    const listed = (await world.alice.get("/correction-requests")).body as { correctionRequests: CorrectionRequest[] };
    expect(listed.correctionRequests.map((request) => request.state)).toEqual(["pending", "pending", "pending", "rejected"]);
    expect(await trailOf(world.alice, "term_result.changed")).toEqual([]);
  });
});
