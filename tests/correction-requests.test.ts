import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import type { Person } from "../src/identity/index.ts";
import { observable, useTestServer, type TestClient, type TestResponse } from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const AVERY = { username: "avery", password: "a second administrator's staple" };
const BOB = { username: "bob", password: "yet another staple, longer" };
const FRANKIE = { username: "frankie", password: "a faculty member's staple" };
const CASEY = { username: "casey", password: "a co-teacher's staple" };
const ELLIS = { username: "ellis", password: "a former teacher's staple" };
const SAM = { username: "sam", password: "a student's staple, first" };
const GINA = { username: "gina", password: "a guardian's staple, twice over" };
const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

type Status = "present" | "tardy" | "excused_absence" | "unexcused_absence" | "absent_pending_review";

interface Named {
  id: string;
  displayName: string;
}

interface CorrectionRequest {
  id: string;
  kind: "attendance";
  state: "pending" | "approved" | "rejected" | "withdrawn";
  student: Named;
  classOffering: { id: string; course: { name: string } };
  date: string;
  before: Status | null;
  after: Status;
  reason: string;
  requestedBy: Named;
  raisedAt: string;
  decidedBy: Named | null;
  decidedAt: string | null;
  rejectionReason: string | null;
  selfApproved: boolean;
}

interface Recorded {
  actorPersonId: string | null;
  action: string;
  target: { type: string; id: string | null };
  reason: string | null;
  before: unknown;
  after: unknown;
}

/** The School date `days` after this one, which may be negative. */
function shifted(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

describe("Correction requests", () => {
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
    /** Frankie: Faculty teaching the offering all Term. Casey teaches it too. */
    frankie: TestClient;
    frankiePerson: Person;
    casey: TestClient;
    /** Ellis: Faculty whose assignment to the offering ended yesterday. */
    ellis: TestClient;
    /** Sam and Sky: Students enrolled and rostered all Term. */
    sam: TestClient;
    samPerson: Person;
    skyPerson: Person;
    /** Lee: rostered all Term, but their Enrollment ended three days ago. */
    leePerson: Person;
    /** Gina: Sam's Guardian, with attendance read. */
    gina: TestClient;
    today: string;
    /** An Instructional day long past its window, on which Sam is marked Present and Sky is not marked. */
    closed: string;
    /** A date inside the Term taken out of the year's Instructional days. */
    dayOff: string;
    offering: { id: string };
  }

  /**
   * Northside's year runs sixty days either side of today, every day an
   * Instructional day but one, in one Term, with the default seven-day window.
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
    const { academicYear } = year.body as { academicYear: { id: string } };
    const divided = await alice.patch(`/academic-years/${academicYear.id}`, {
      terms: [{ name: "Whole", firstDate: shifted(today, -60), lastDate: shifted(today, 60) }],
    });
    const [term] = (divided.body as { academicYear: { terms: { id: string }[] } }).academicYear.terms;
    const dayOff = shifted(today, -2);
    await alice.post(`/academic-years/${academicYear.id}/exceptions`, { date: dayOff, instructional: false });
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
    const casey = await person(CASEY, "Casey", "faculty");
    const ellis = await person(ELLIS, "Ellis", "faculty");
    for (const [faculty, bounds] of [
      [frankie.person, {}],
      [casey.person, {}],
      [ellis.person, { firstDate: shifted(today, -60), lastDate: shifted(today, -1) }],
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
    const rostered = await alice.post(`/class-offerings/${offering.id}/roster-memberships`, {
      personIds: [sam.person.id, sky.person.id, lee.person.id],
    });
    expect(rostered.status).toBe(201);
    await server().ownerDatabase.query(
      `UPDATE app.enrollment
       SET started_at = now() - interval '30 days', ended_at = now() - interval '3 days', end_reason = 'Moved away'
       WHERE student_person_id = $1`,
      [lee.person.id],
    );
    const gina = await person(GINA, "Gina", "guardian");
    await alice.post("/guardian-links", {
      guardianPersonId: gina.person.id,
      studentPersonId: sam.person.id,
      accessProfile: { attendanceRead: true, resultsRead: true },
    });

    // Recorded as Frankie did on the day, since when its window has closed.
    const closed = shifted(today, -20);
    await server().ownerDatabase.query(
      `INSERT INTO app.attendance (school_id, student_person_id, class_offering_id, date, status, recorded_by_person_id)
       VALUES ($1, $2, $3, $4, 'present', $5)`,
      [schoolId, sam.person.id, offering.id, closed, frankie.person.id],
    );

    return {
      schoolId,
      alice,
      alicePerson: northside.schoolAdministrator,
      avery: avery.client!,
      averyPerson: avery.person,
      bob: (await server().sessionFor(bobAccount)).inSchool(westbrook.school.id),
      frankie: frankie.client!,
      frankiePerson: frankie.person,
      casey: casey.client!,
      ellis: ellis.client!,
      sam: sam.client!,
      samPerson: sam.person,
      skyPerson: sky.person,
      leePerson: lee.person,
      gina: gina.client!,
      today,
      closed,
      dayOff,
      offering,
    };
  }

  interface Raise {
    studentPersonId: string;
    date: string;
    after: Status;
    reason?: string;
  }

  function raise(world: World, as: TestClient, { reason = "Seen in the office", ...target }: Raise): Promise<TestResponse> {
    return as.post(`/class-offerings/${world.offering.id}/correction-requests`, { kind: "attendance", reason, ...target });
  }

  async function raised(world: World, as: TestClient, target: Raise): Promise<CorrectionRequest> {
    const response = await raise(world, as, target);
    expect(response.status).toBe(201);
    return (response.body as { correctionRequest: CorrectionRequest }).correctionRequest;
  }

  type Decision = "approve" | "reject" | "withdraw";
  const STATES = { approve: "approved", reject: "rejected", withdraw: "withdrawn" } as const;

  function decide(as: TestClient, request: { id: string }, decision: Decision, fields: { reason?: string } = {}) {
    return as.patch(`/correction-requests/${request.id}`, { state: STATES[decision], ...fields });
  }

  async function decided(as: TestClient, request: { id: string }, decision: Decision, fields?: { reason?: string }) {
    const response = await decide(as, request, decision, fields);
    expect(response.status).toBe(200);
    return (response.body as { correctionRequest: CorrectionRequest }).correctionRequest;
  }

  async function markOf(world: World, studentPersonId: string, date: string) {
    const { rows } = await server().ownerDatabase.query<{ status: Status; recordedBy: string }>(
      `SELECT status, recorded_by_person_id AS "recordedBy" FROM app.attendance
       WHERE student_person_id = $1 AND class_offering_id = $2 AND date = $3`,
      [studentPersonId, world.offering.id, date],
    );
    return rows[0] ?? null;
  }

  async function trailOf(admin: TestClient, prefix: string): Promise<Recorded[]> {
    const response = await admin.get("/audit-records");
    expect(response.status).toBe(200);
    return (response.body as { auditRecords: Recorded[] }).auditRecords.filter((record) => record.action.startsWith(prefix));
  }

  function conflictOf(response: TestResponse) {
    return { status: response.status, body: response.body };
  }

  it("is raised by Faculty teaching the offering or a School Administrator, to change a closed mark, add a missing one, or resolve an Absent-pending-review", async () => {
    const world = await arrange();
    const opened = await world.frankie.patch(`/class-offerings/${world.offering.id}/attendance-session`, {
      date: world.today,
      marks: [{ studentPersonId: world.samPerson.id, loaded: null, status: "absent_pending_review" }],
    });
    expect(opened.status).toBe(200);

    const changed = await raised(world, world.frankie, { studentPersonId: world.samPerson.id, date: world.closed, after: "tardy" });
    const added = await raised(world, world.frankie, {
      studentPersonId: world.skyPerson.id,
      date: world.closed,
      after: "excused_absence",
      reason: "The note came late",
    });
    // Inside the window: an Absent-pending-review is resolved only this way.
    const resolved = await raised(world, world.alice, { studentPersonId: world.samPerson.id, date: world.today, after: "excused_absence" });

    expect(changed).toEqual({
      id: expect.any(String),
      kind: "attendance",
      state: "pending",
      student: { id: world.samPerson.id, displayName: "Sam" },
      classOffering: expect.objectContaining({ id: world.offering.id, course: expect.objectContaining({ name: "Algebra I" }) }),
      date: world.closed,
      before: "present",
      after: "tardy",
      reason: "Seen in the office",
      requestedBy: { id: world.frankiePerson.id, displayName: "Frankie" },
      raisedAt: expect.any(String),
      decidedBy: null,
      decidedAt: null,
      rejectionReason: null,
      selfApproved: false,
    });
    expect(added).toEqual(expect.objectContaining({ before: null, after: "excused_absence", reason: "The note came late" }));
    expect(resolved).toEqual(
      expect.objectContaining({ before: "absent_pending_review", requestedBy: { id: world.alicePerson.id, displayName: world.alicePerson.displayName } }),
    );
    // Raising changes no Attendance.
    expect(await markOf(world, world.samPerson.id, world.closed)).toEqual(expect.objectContaining({ status: "present" }));
    expect(await markOf(world, world.skyPerson.id, world.closed)).toBeNull();
    expect(await trailOf(world.alice, "correction_request.")).toEqual([
      expect.objectContaining({ action: "correction_request.raised", actorPersonId: world.frankiePerson.id, target: { type: "correction_request", id: changed.id }, before: null, after: expect.objectContaining({ state: "pending", beforeValue: "present", afterValue: "tardy" }) }),
      expect.objectContaining({ action: "correction_request.raised", target: { type: "correction_request", id: added.id } }),
      expect.objectContaining({ action: "correction_request.raised", target: { type: "correction_request", id: resolved.id } }),
    ].reverse());
  });

  it("is refused for a date or Student that could not have Attendance, and for a change to nothing", async () => {
    const world = await arrange();

    const cases: [string, Raise, unknown][] = [
      ["a date that is not an Instructional day", { studentPersonId: world.samPerson.id, date: world.dayOff, after: "present" }, "not_instructional_day"],
      ["a date outside the Term", { studentPersonId: world.samPerson.id, date: shifted(world.today, -61), after: "present" }, "not_instructional_day"],
      ["a date after today", { studentPersonId: world.samPerson.id, date: shifted(world.today, 1), after: "present" }, "after_today"],
      ["a Student whose Enrollment had ended", { studentPersonId: world.leePerson.id, date: world.today, after: "present" }, "enrollment_ended"],
      ["a Person not rostered", { studentPersonId: world.frankiePerson.id, date: world.today, after: "present" }, "not_rostered_on_date"],
      ["a Person who does not exist", { studentPersonId: ABSENT_ID, date: world.today, after: "present" }, "not_rostered_on_date"],
      ["the value it already holds", { studentPersonId: world.samPerson.id, date: world.closed, after: "present" }, "unchanged"],
    ];
    const answered: string[] = [];
    for (const [what, target, conflict] of cases) {
      const response = await raise(world, world.frankie, target);
      if (!isDeepStrictEqual(conflictOf(response), { status: 409, body: { status: "conflict", conflict } })) {
        answered.push(`${what} answered ${response.status} ${JSON.stringify(response.body)}`);
      }
    }
    const withoutReason = await world.frankie.post(`/class-offerings/${world.offering.id}/correction-requests`, {
      kind: "attendance",
      studentPersonId: world.samPerson.id,
      date: world.closed,
      after: "tardy",
    });
    const unknownStatus = await raise(world, world.frankie, { studentPersonId: world.samPerson.id, date: world.closed, after: "late" as Status });

    expect(answered).toEqual([]);
    expect(withoutReason.status).toBe(400);
    expect(unknownStatus.status).toBe(400);
    const { rows } = await server().ownerDatabase.query(`SELECT count(*)::int AS count FROM app.correction_request`);
    expect(rows).toEqual([{ count: 0 }]);
  });

  it("is approved by another School Administrator, applying the change at once, and audited with before and after values", async () => {
    const world = await arrange();
    const changed = await raised(world, world.frankie, { studentPersonId: world.samPerson.id, date: world.closed, after: "tardy" });
    const added = await raised(world, world.frankie, { studentPersonId: world.skyPerson.id, date: world.closed, after: "unexcused_absence" });

    const approved = await decided(world.alice, changed, "approve");
    const alsoApproved = await decided(world.avery, added, "approve");

    expect(approved).toEqual(
      expect.objectContaining({
        state: "approved",
        decidedBy: { id: world.alicePerson.id, displayName: world.alicePerson.displayName },
        decidedAt: expect.any(String),
        selfApproved: false,
      }),
    );
    expect(alsoApproved.state).toBe("approved");
    expect(await markOf(world, world.samPerson.id, world.closed)).toEqual({ status: "tardy", recordedBy: world.alicePerson.id });
    expect(await markOf(world, world.skyPerson.id, world.closed)).toEqual({ status: "unexcused_absence", recordedBy: world.averyPerson.id });
    const session = await world.frankie.get(`/class-offerings/${world.offering.id}/attendance-session?date=${world.closed}`);
    const students = (session.body as { attendanceSession: { students: { person: Named; attendance: { status: Status } | null }[] } })
      .attendanceSession.students;
    expect(students.map((student) => [student.person.displayName, student.attendance?.status ?? null])).toEqual([
      ["Sam", "tardy"],
      ["Sky", "unexcused_absence"],
    ]);
    expect(await trailOf(world.alice, "correction_request.approved")).toEqual([
      expect.objectContaining({
        actorPersonId: world.averyPerson.id,
        target: { type: "correction_request", id: added.id },
        before: expect.objectContaining({ state: "pending" }),
        after: expect.objectContaining({ state: "approved", selfApproved: false }),
      }),
      expect.objectContaining({ actorPersonId: world.alicePerson.id, target: { type: "correction_request", id: changed.id } }),
    ]);
    expect(await trailOf(world.alice, "attendance.changed")).toEqual([
      expect.objectContaining({
        actorPersonId: world.alicePerson.id,
        reason: "Seen in the office",
        before: expect.objectContaining({ studentPersonId: world.samPerson.id, status: "present" }),
        after: expect.objectContaining({ studentPersonId: world.samPerson.id, status: "tardy" }),
      }),
    ]);
  });

  it("is rejected with a reason, or withdrawn by its requester, from Pending only, and each by the right actor", async () => {
    const world = await arrange();
    const target = { studentPersonId: world.samPerson.id, date: world.closed, after: "tardy" as const };
    const toReject = await raised(world, world.frankie, target);
    const toWithdraw = await raised(world, world.frankie, target);
    const refusal = await world.frankie.get(`/persons/${ABSENT_ID}`);

    const refused: [string, () => Promise<TestResponse>][] = [
      ["the requester approving, as Faculty", () => decide(world.frankie, toReject, "approve")],
      ["the requester rejecting, as Faculty", () => decide(world.frankie, toReject, "reject", { reason: "No" })],
      ["a co-teacher withdrawing", () => decide(world.casey, toWithdraw, "withdraw")],
      ["a School Administrator withdrawing another's", () => decide(world.alice, toWithdraw, "withdraw")],
      ["a Student approving", () => decide(world.sam, toReject, "approve")],
      ["another School's Administrator approving", () => decide(world.bob.inSchool(world.schoolId), toReject, "approve")],
      ["approving one that does not exist", () => decide(world.alice, { id: ABSENT_ID }, "approve")],
    ];
    const answered: string[] = [];
    for (const [what, attempt] of refused) {
      const response = await attempt();
      if (!isDeepStrictEqual(observable(response), observable(refusal))) {
        answered.push(`${what} answered ${response.status}`);
      }
    }
    const withoutReason = await decide(world.alice, toReject, "reject");
    const rejected = await decided(world.alice, toReject, "reject", { reason: "The register says otherwise" });
    const withdrawn = await decided(world.frankie, toWithdraw, "withdraw");
    const again = [
      await decide(world.avery, rejected, "approve"),
      await decide(world.avery, rejected, "reject", { reason: "Again" }),
      await decide(world.frankie, rejected, "withdraw"),
      await decide(world.alice, withdrawn, "approve"),
      await decide(world.frankie, withdrawn, "withdraw"),
    ];

    expect(answered).toEqual([]);
    expect(withoutReason.status).toBe(400);
    expect(rejected).toEqual(
      expect.objectContaining({
        state: "rejected",
        rejectionReason: "The register says otherwise",
        decidedBy: { id: world.alicePerson.id, displayName: world.alicePerson.displayName },
      }),
    );
    expect(withdrawn).toEqual(
      expect.objectContaining({ state: "withdrawn", decidedBy: { id: world.frankiePerson.id, displayName: "Frankie" } }),
    );
    expect(again.map(conflictOf)).toEqual(Array(5).fill({ status: 409, body: { status: "conflict", conflict: "not_pending" } }));
    expect(await markOf(world, world.samPerson.id, world.closed)).toEqual(expect.objectContaining({ status: "present" }));
    const trail = await trailOf(world.alice, "correction_request.");
    expect(trail.slice(0, 2)).toEqual([
      expect.objectContaining({
        action: "correction_request.withdrawn",
        actorPersonId: world.frankiePerson.id,
        before: expect.objectContaining({ state: "pending" }),
        after: expect.objectContaining({ state: "withdrawn" }),
      }),
      expect.objectContaining({
        action: "correction_request.rejected",
        actorPersonId: world.alicePerson.id,
        reason: "The register says otherwise",
        before: expect.objectContaining({ state: "pending" }),
        after: expect.objectContaining({ state: "rejected" }),
      }),
    ]);
  });

  it("refuses self-approval while the School has another School Administrator, and allows and marks it with one", async () => {
    const world = await arrange();
    const own = await raised(world, world.alice, { studentPersonId: world.samPerson.id, date: world.closed, after: "tardy" });
    const another = await raised(world, world.alice, { studentPersonId: world.skyPerson.id, date: world.closed, after: "present" });

    const selfApproving = await decide(world.alice, own, "approve");
    const selfRejecting = await decide(world.alice, own, "reject", { reason: "Changed my mind" });
    const byAvery = await decided(world.avery, another, "approve");
    // Avery's membership ends, leaving Alice the only School Administrator.
    await server().ownerDatabase.query(
      `UPDATE app.school_membership SET ends_at = now() WHERE person_id = $1`,
      [world.averyPerson.id],
    );
    const selfApproved = await decided(world.alice, own, "approve");

    expect(conflictOf(selfApproving)).toEqual({ status: 409, body: { status: "conflict", conflict: "own_request" } });
    expect(conflictOf(selfRejecting)).toEqual({ status: 409, body: { status: "conflict", conflict: "own_request" } });
    expect(byAvery.selfApproved).toBe(false);
    expect(selfApproved).toEqual(expect.objectContaining({ state: "approved", selfApproved: true }));
    expect(await markOf(world, world.samPerson.id, world.closed)).toEqual(expect.objectContaining({ status: "tardy" }));
    const [latest] = await trailOf(world.alice, "correction_request.approved");
    expect(latest).toEqual(
      expect.objectContaining({ actorPersonId: world.alicePerson.id, after: expect.objectContaining({ selfApproved: true }) }),
    );
  });

  it("refuses approval once the target has changed since the request was raised", async () => {
    const world = await arrange();
    const inWindow = shifted(world.today, -1);
    const path = `/class-offerings/${world.offering.id}/attendance-session`;
    await world.frankie.patch(path, {
      date: inWindow,
      marks: [{ studentPersonId: world.samPerson.id, loaded: null, status: "present" }],
    });
    const changing = await raised(world, world.alice, { studentPersonId: world.samPerson.id, date: inWindow, after: "excused_absence" });
    const adding = await raised(world, world.alice, { studentPersonId: world.skyPerson.id, date: inWindow, after: "excused_absence" });
    // Frankie changes one mark, and adds the other, after the requests were raised.
    await world.frankie.patch(path, {
      date: inWindow,
      marks: [
        { studentPersonId: world.samPerson.id, loaded: "present", status: "tardy" },
        { studentPersonId: world.skyPerson.id, loaded: null, status: "present" },
      ],
    });

    const responses = [await decide(world.avery, changing, "approve"), await decide(world.avery, adding, "approve")];

    for (const response of responses) {
      expect(conflictOf(response)).toEqual({ status: 409, body: { status: "conflict", conflict: "target_changed" } });
    }
    expect(await markOf(world, world.samPerson.id, inWindow)).toEqual(expect.objectContaining({ status: "tardy" }));
    expect(await markOf(world, world.skyPerson.id, inWindow)).toEqual(expect.objectContaining({ status: "present" }));
    const listed = (await world.alice.get("/correction-requests")).body as { correctionRequests: CorrectionRequest[] };
    expect(listed.correctionRequests.map((request) => request.state)).toEqual(["pending", "pending"]);
  });

  it("is listed to School Administrators whole, Pending first and oldest first, and to any other requester their own only", async () => {
    const world = await arrange();
    const first = await raised(world, world.frankie, { studentPersonId: world.samPerson.id, date: world.closed, after: "tardy" });
    const second = await raised(world, world.alice, { studentPersonId: world.skyPerson.id, date: world.closed, after: "present" });
    const third = await raised(world, world.frankie, { studentPersonId: world.skyPerson.id, date: world.closed, after: "tardy" });
    await decided(world.frankie, first, "withdraw");
    const refusal = await world.frankie.get(`/persons/${ABSENT_ID}`);

    const byAlice = await world.alice.get("/correction-requests");
    const byFrankie = await world.frankie.get("/correction-requests");
    const byCasey = await world.casey.get("/correction-requests");

    const idsOf = (response: TestResponse) =>
      (response.body as { correctionRequests: CorrectionRequest[] }).correctionRequests.map((request) => request.id);
    expect(idsOf(byAlice)).toEqual([second.id, third.id, first.id]);
    expect(idsOf(byFrankie)).toEqual([third.id, first.id]);
    expect(idsOf(byCasey)).toEqual([]);
    const answered: string[] = [];
    for (const [what, as] of [
      ["a Student", world.sam],
      ["a Guardian", world.gina],
      ["another School's Administrator", world.bob.inSchool(world.schoolId)],
      ["a caller with no session", server().client.inSchool(world.schoolId)],
    ] as const) {
      const response = await as.get("/correction-requests");
      if (!isDeepStrictEqual(observable(response), observable(refusal))) {
        answered.push(`${what} answered ${response.status}`);
      }
    }
    expect(answered).toEqual([]);
  });

  it("gives a former teacher, every other role, and another School the one refusal when raising", async () => {
    const world = await arrange();
    const refusal = await world.frankie.get(`/persons/${ABSENT_ID}`);
    const target = { studentPersonId: world.samPerson.id, date: world.closed, after: "tardy" as const };

    const attempts: [string, () => Promise<TestResponse>][] = [
      ["a former teacher", () => raise(world, world.ellis, target)],
      ["a Student", () => raise(world, world.sam, target)],
      ["a Guardian", () => raise(world, world.gina, target)],
      ["another School's Administrator", () => raise(world, world.bob.inSchool(world.schoolId), target)],
      // Refused before the rest of the body is read, so nonsense says nothing more.
      ["a former teacher sending nonsense", () => world.ellis.post(`/class-offerings/${world.offering.id}/correction-requests`, { date: 7 })],
      [
        "an offering that does not exist",
        () => world.alice.post(`/class-offerings/${ABSENT_ID}/correction-requests`, { kind: "attendance", ...target, reason: "x" }),
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
    const { rows } = await server().ownerDatabase.query(`SELECT count(*)::int AS count FROM app.correction_request`);
    expect(rows).toEqual([{ count: 0 }]);
  });
});
