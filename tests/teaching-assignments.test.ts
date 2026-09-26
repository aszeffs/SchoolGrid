import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import type { Person } from "../src/identity/index.ts";
import { observable, useTestServer, type TestClient } from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const BOB = { username: "bob", password: "yet another staple, longer" };
const FRANKIE = { username: "frankie", password: "a faculty member's staple" };
const FLYNN = {
  username: "flynn",
  password: "another faculty member's staple",
};
const SAM = { username: "sam", password: "a different staple entirely" };
const GINA = { username: "gina", password: "a guardian's staple, twice over" };
const PAT = { username: "pat", password: "a platform operator's staple" };
const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

interface Recorded {
  actorPersonId: string | null;
  action: string;
  target: { type: string; id: string | null };
  reason: string | null;
  before: unknown;
  after: unknown;
}

interface Term {
  id: string;
  name: string;
  firstDate: string;
  lastDate: string;
}

interface TeachingAssignment {
  id: string;
  person: { id: string; displayName: string };
  firstDate: string;
  lastDate: string | null;
}

interface ClassOffering {
  id: string;
  label: string | null;
  course: { id: string; name: string };
  term: Term;
  teachingAssignments?: TeachingAssignment[];
}

interface Membership {
  id: string;
  personId: string;
  role: string;
}

/** The School date `days` after this one, which may be negative. */
function shifted(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

describe("Teaching assignments", () => {
  const server = useTestServer();

  interface World {
    northsideId: string;
    westbrookId: string;
    aliceId: string;
    /** Alice: Northside's School Administrator. */
    alice: TestClient;
    /** Bob: Westbrook's School Administrator, and nothing at Northside. */
    bob: TestClient;
    /** Frankie and Flynn: Northside's Faculty, each signed in. */
    frankie: TestClient;
    frankiePerson: Person;
    flynn: TestClient;
    flynnPerson: Person;
    /** Northside's School date today, in New York unless arranged elsewhere. */
    today: string;
    /** Northside's year, divided so that one Term is over, one is running today, and one is still to come. */
    past: Term;
    current: Term;
    next: Term;
    /** An offering in each of those Terms. */
    pastOffering: ClassOffering;
    offering: ClassOffering;
    nextOffering: ClassOffering;
    /** Westbrook's own offering, for reaching across Schools. */
    westbrookOffering: ClassOffering;
  }

  async function arrange(timezone = "America/New_York"): Promise<World> {
    const aliceAccount = await server().createAccount(ALICE);
    const bobAccount = await server().createAccount(BOB);
    const northside = await server().provisionSchool({
      name: "Northside",
      timezone,
      administrator: aliceAccount,
    });
    const westbrook = await server().provisionSchool({
      name: "Westbrook",
      administrator: bobAccount,
    });
    const schoolId = northside.school.id;
    const alice = (await server().sessionFor(aliceAccount)).inSchool(schoolId);
    const bob = (await server().sessionFor(bobAccount)).inSchool(westbrook.school.id);
    const frankieAccount = await server().createAccount(FRANKIE);
    const flynnAccount = await server().createAccount(FLYNN);
    const frankiePerson = await server().createPerson({
      schoolId,
      displayName: "Frankie",
      account: frankieAccount,
      role: "faculty",
    });
    const flynnPerson = await server().createPerson({
      schoolId,
      displayName: "Flynn",
      account: flynnAccount,
      role: "faculty",
    });
    const today = ((await alice.get("/school-date")).body as { schoolDate: string }).schoolDate;
    const [past, current, next] = await divide(alice, [
      {
        name: "Past",
        firstDate: shifted(today, -200),
        lastDate: shifted(today, -101),
      },
      {
        name: "Current",
        firstDate: shifted(today, -100),
        lastDate: shifted(today, 100),
      },
      {
        name: "Next",
        firstDate: shifted(today, 101),
        lastDate: shifted(today, 200),
      },
    ]);
    const [westbrookTerm] = await divide(bob, [{ name: "Whole", firstDate: today, lastDate: today }]);
    const courseId = await createCourse(alice, "Algebra I");
    return {
      northsideId: schoolId,
      westbrookId: westbrook.school.id,
      aliceId: northside.schoolAdministrator.id,
      alice,
      bob,
      frankie: (await server().sessionFor(frankieAccount)).inSchool(schoolId),
      frankiePerson,
      flynn: (await server().sessionFor(flynnAccount)).inSchool(schoolId),
      flynnPerson,
      today,
      past: past!,
      current: current!,
      next: next!,
      pastOffering: await offer(alice, courseId, past!),
      offering: await offer(alice, courseId, current!),
      nextOffering: await offer(alice, courseId, next!),
      westbrookOffering: await offer(bob, await createCourse(bob, "Algebra I"), westbrookTerm!),
    };
  }

  /** Creates a year covering these Terms exactly, returning them. */
  async function divide(admin: TestClient, terms: Omit<Term, "id">[]): Promise<Term[]> {
    const created = await admin.post("/academic-years", {
      name: "The year",
      firstDate: terms[0]!.firstDate,
      lastDate: terms.at(-1)!.lastDate,
    });
    expect(created.status).toBe(201);
    const { id } = (created.body as { academicYear: { id: string } }).academicYear;
    const divided = await admin.patch(`/academic-years/${id}`, { terms });
    expect(divided.status).toBe(200);
    return (divided.body as { academicYear: { terms: Term[] } }).academicYear.terms;
  }

  async function createCourse(admin: TestClient, name: string): Promise<string> {
    const response = await admin.post("/courses", { name });
    expect(response.status).toBe(201);
    return (response.body as { course: { id: string } }).course.id;
  }

  async function offer(admin: TestClient, courseId: string, term: Term): Promise<ClassOffering> {
    const response = await admin.post("/class-offerings", {
      courseId,
      termId: term.id,
      label: term.name,
    });
    expect(response.status).toBe(201);
    return (response.body as { classOffering: ClassOffering }).classOffering;
  }

  async function assign(
    admin: TestClient,
    offering: ClassOffering,
    assignment: {
      personId: string;
      firstDate?: string;
      lastDate?: string | null;
    },
  ): Promise<TeachingAssignment> {
    const response = await admin.post(`/class-offerings/${offering.id}/teaching-assignments`, assignment);
    expect(response.status).toBe(201);
    return (response.body as { teachingAssignment: TeachingAssignment }).teachingAssignment;
  }

  async function assignmentsOn(admin: TestClient, offering: ClassOffering): Promise<TeachingAssignment[]> {
    const response = await admin.get(`/class-offerings/${offering.id}`);
    expect(response.status).toBe(200);
    return (response.body as { classOffering: ClassOffering }).classOffering.teachingAssignments!;
  }

  async function membershipOf(admin: TestClient, person: Person, role: string): Promise<Membership> {
    const response = await admin.get("/memberships");
    expect(response.status).toBe(200);
    return (response.body as { memberships: Membership[] }).memberships.find(
      (membership) => membership.personId === person.id && membership.role === role,
    )!;
  }

  async function trailOf(admin: TestClient, ...actions: string[]): Promise<Recorded[]> {
    const response = await admin.get("/audit-records");
    expect(response.status).toBe(200);
    return (response.body as { auditRecords: Recorded[] }).auditRecords.filter((record) =>
      actions.includes(record.action),
    );
  }

  /** Every Teaching assignment, as the schema owner sees it. */
  async function stored() {
    const { rows } = await server().ownerDatabase.query(
      `SELECT id, school_id, class_offering_id, faculty_person_id, first_date::text, last_date::text
       FROM app.teaching_assignment ORDER BY id`,
    );
    return rows;
  }

  describe("assigning", () => {
    it("assigns Faculty to a Class Offering, bounded by its Term unless told otherwise, and records each", async () => {
      const world = await arrange();
      const { current } = world;

      const response = await world.alice.post(`/class-offerings/${world.offering.id}/teaching-assignments`, {
        personId: world.frankiePerson.id,
        reason: "Timetabling",
      });
      // Several at once, one of them from part way through the Term to part way before its end.
      const partWay = await assign(world.alice, world.offering, {
        personId: world.flynnPerson.id,
        firstDate: shifted(current.firstDate, 10),
        lastDate: shifted(current.lastDate, -10),
      });

      expect(response.status).toBe(201);
      const { teachingAssignment } = response.body as {
        teachingAssignment: TeachingAssignment;
      };
      expect(teachingAssignment).toEqual({
        id: expect.any(String),
        person: { id: world.frankiePerson.id, displayName: "Frankie" },
        firstDate: current.firstDate,
        lastDate: null,
      });
      expect(await assignmentsOn(world.alice, world.offering)).toEqual([teachingAssignment, partWay]);
      expect(await trailOf(world.alice, "teaching_assignment.created")).toEqual([
        expect.objectContaining({
          after: {
            classOfferingId: world.offering.id,
            personId: world.flynnPerson.id,
            firstDate: shifted(current.firstDate, 10),
            lastDate: shifted(current.lastDate, -10),
          },
        }),
        expect.objectContaining({
          actorPersonId: world.aliceId,
          target: { type: "teaching_assignment", id: teachingAssignment.id },
          reason: "Timetabling",
          before: null,
          after: {
            classOfferingId: world.offering.id,
            personId: world.frankiePerson.id,
            firstDate: current.firstDate,
            lastDate: null,
          },
        }),
      ]);
    });

    it("refuses bounds that overlap the Person's own, fall outside the Term, or are out of order", async () => {
      const world = await arrange();
      const { current } = world;
      await assign(world.alice, world.offering, {
        personId: world.frankiePerson.id,
        lastDate: shifted(current.firstDate, 20),
      });
      // The same Person again, once the first has ended, is a second assignment of their own.
      await assign(world.alice, world.offering, {
        personId: world.frankiePerson.id,
        firstDate: shifted(current.firstDate, 30),
        lastDate: shifted(current.firstDate, 40),
      });
      const before = await stored();
      const path = `/class-offerings/${world.offering.id}/teaching-assignments`;
      const frankie = world.frankiePerson.id;

      const overlapping = await world.alice.post(path, {
        personId: frankie,
        firstDate: shifted(current.firstDate, 20),
      });
      const outside = [
        await world.alice.post(path, {
          personId: world.flynnPerson.id,
          firstDate: shifted(current.firstDate, -1),
        }),
        await world.alice.post(path, {
          personId: world.flynnPerson.id,
          lastDate: shifted(current.lastDate, 1),
        }),
      ];
      const malformed = [
        await world.alice.post(path, {
          personId: frankie,
          firstDate: shifted(current.firstDate, 60),
          lastDate: shifted(current.firstDate, 50),
        }),
        await world.alice.post(path, {
          personId: frankie,
          firstDate: "tomorrow",
        }),
        await world.alice.post(path, { personId: 5 }),
        await world.alice.post(path, { personId: frankie, colour: "red" }),
      ];

      expect(overlapping.status).toBe(409);
      expect(overlapping.body).toEqual({
        status: "conflict",
        conflict: "teaching_assignment_overlap",
      });
      for (const response of outside) {
        expect(response.status).toBe(409);
        expect(response.body).toEqual({
          status: "conflict",
          conflict: "teaching_assignment_outside_term",
        });
      }
      expect(malformed.map((response) => response.status)).toEqual([400, 400, 400, 400]);
      expect(await stored()).toEqual(before);
    });

    it("refuses a Person without an active Faculty membership, and one running past its end", async () => {
      const world = await arrange();
      const { northsideId, current } = world;
      const student = await server().createPerson({
        schoolId: northsideId,
        displayName: "Sam",
        role: "student",
      });
      const later = await server().createPerson({
        schoolId: northsideId,
        displayName: "Later",
      });
      await server().grantMembership({
        person: later,
        role: "faculty",
        startsAt: new Date(Date.now() + 86_400_000),
      });
      const former = await server().createPerson({
        schoolId: northsideId,
        displayName: "Former",
      });
      await server().grantMembership({
        person: former,
        role: "faculty",
        startsAt: new Date(Date.now() - 2 * 86_400_000),
        endsAt: new Date(Date.now() - 86_400_000),
      });
      // Faculty until noon, New York time, fifty days from today.
      const leaving = await server().createPerson({
        schoolId: northsideId,
        displayName: "Leaving",
      });
      const leavesOn = shifted(world.today, 50);
      // A second, open Faculty membership does not lift the cap: the one ending first binds.
      await server().grantMembership({ person: leaving, role: "faculty" });
      await server().grantMembership({
        person: leaving,
        role: "faculty",
        endsAt: new Date(`${leavesOn}T16:00:00Z`),
      });
      const path = `/class-offerings/${world.offering.id}/teaching-assignments`;

      const refused = [
        await world.alice.post(path, { personId: student.id }),
        await world.alice.post(path, { personId: later.id }),
        await world.alice.post(path, { personId: former.id }),
        await world.alice.post(path, {
          personId: leaving.id,
          lastDate: shifted(leavesOn, 1),
        }),
        await world.alice.post(path, { personId: leaving.id, lastDate: null }),
      ];
      const beforeOnes = await stored();
      // Left unbounded, it runs until the day the membership ends.
      const bounded = await assign(world.alice, world.offering, {
        personId: leaving.id,
      });

      expect(refused.map((response) => response.status)).toEqual([400, 400, 400, 400, 400]);
      expect(beforeOnes).toEqual([]);
      expect(bounded).toEqual(
        expect.objectContaining({
          firstDate: current.firstDate,
          lastDate: leavesOn,
        }),
      );
    });

    it("cannot assign to another School's offering, or assign another School's Person", async () => {
      const world = await arrange();
      const westbrookFaculty = await server().createPerson({
        schoolId: world.westbrookId,
        displayName: "Wes",
        role: "faculty",
      });
      const refusal = await world.alice.get(`/persons/${ABSENT_ID}`);

      const attempts = [
        await world.alice.post(`/class-offerings/${world.westbrookOffering.id}/teaching-assignments`, {
          personId: world.frankiePerson.id,
        }),
        await world.alice.post(`/class-offerings/${ABSENT_ID}/teaching-assignments`, {
          personId: world.frankiePerson.id,
        }),
        await world.alice.post(`/class-offerings/${world.offering.id}/teaching-assignments`, {
          personId: westbrookFaculty.id,
        }),
        await world.alice.post(`/class-offerings/${world.offering.id}/teaching-assignments`, { personId: ABSENT_ID }),
      ];

      for (const response of attempts) {
        expect(observable(response)).toEqual(observable(refusal));
      }
      expect(await stored()).toEqual([]);
    });
  });

  describe("changing and ending", () => {
    it("changes bounds, ends one on today's School date, and deletes one not yet begun, recording each", async () => {
      const world = await arrange();
      const { current, today } = world;
      const running = await assign(world.alice, world.offering, {
        personId: world.frankiePerson.id,
      });
      const upcoming = await assign(world.alice, world.nextOffering, {
        personId: world.frankiePerson.id,
      });
      const values = {
        classOfferingId: world.offering.id,
        personId: world.frankiePerson.id,
      };

      const moved = await world.alice.patch(`/teaching-assignments/${running.id}`, {
        firstDate: shifted(current.firstDate, 5),
        reason: "Started late",
      });
      const ended = await world.alice.delete(`/teaching-assignments/${running.id}`, { reason: "Left the class" });
      const endedAgain = await world.alice.delete(`/teaching-assignments/${running.id}`);
      const removed = await world.alice.delete(`/teaching-assignments/${upcoming.id}`, { reason: "Not needed" });

      expect(moved.status).toBe(200);
      expect(moved.body).toEqual({
        teachingAssignment: {
          ...running,
          firstDate: shifted(current.firstDate, 5),
        },
      });
      expect(ended.status).toBe(200);
      expect(ended.body).toEqual({
        teachingAssignment: {
          ...running,
          firstDate: shifted(current.firstDate, 5),
          lastDate: today,
        },
      });
      expect(endedAgain.status).toBe(200);
      expect(removed.status).toBe(200);
      expect(await assignmentsOn(world.alice, world.nextOffering)).toEqual([]);
      expect(
        await trailOf(
          world.alice,
          "teaching_assignment.changed",
          "teaching_assignment.ended",
          "teaching_assignment.deleted",
        ),
      ).toEqual([
        expect.objectContaining({
          action: "teaching_assignment.deleted",
          target: { type: "teaching_assignment", id: upcoming.id },
          reason: "Not needed",
          before: {
            classOfferingId: world.nextOffering.id,
            personId: world.frankiePerson.id,
            firstDate: world.next.firstDate,
            lastDate: null,
          },
          after: null,
        }),
        expect.objectContaining({
          action: "teaching_assignment.ended",
          reason: "Left the class",
          before: {
            ...values,
            firstDate: shifted(current.firstDate, 5),
            lastDate: null,
          },
          after: {
            ...values,
            firstDate: shifted(current.firstDate, 5),
            lastDate: today,
          },
        }),
        expect.objectContaining({
          action: "teaching_assignment.changed",
          actorPersonId: world.aliceId,
          target: { type: "teaching_assignment", id: running.id },
          reason: "Started late",
          before: { ...values, firstDate: current.firstDate, lastDate: null },
          after: {
            ...values,
            firstDate: shifted(current.firstDate, 5),
            lastDate: null,
          },
        }),
      ]);
    });

    it("refuses a change that would overlap, leave the Term, or be out of order", async () => {
      const world = await arrange();
      const { current } = world;
      const first = await assign(world.alice, world.offering, {
        personId: world.frankiePerson.id,
        lastDate: shifted(current.firstDate, 9),
      });
      await assign(world.alice, world.offering, {
        personId: world.frankiePerson.id,
        firstDate: shifted(current.firstDate, 10),
      });
      const before = await stored();
      const path = `/teaching-assignments/${first.id}`;

      const overlapping = await world.alice.patch(path, {
        lastDate: shifted(current.firstDate, 10),
      });
      const outside = await world.alice.patch(path, {
        firstDate: shifted(current.firstDate, -1),
      });
      const malformed = [
        await world.alice.patch(path, {
          firstDate: shifted(current.firstDate, 11),
        }),
        await world.alice.patch(path, { personId: world.flynnPerson.id }),
        await world.alice.patch(path, { lastDate: "soon" }),
      ];

      expect(overlapping.body).toEqual({
        status: "conflict",
        conflict: "teaching_assignment_overlap",
      });
      expect(outside.body).toEqual({
        status: "conflict",
        conflict: "teaching_assignment_outside_term",
      });
      expect(malformed.map((response) => response.status)).toEqual([400, 400, 400]);
      expect(await stored()).toEqual(before);
    });
  });

  describe("ending a Faculty membership", () => {
    it("by revoking it ends each open assignment on today's School date, removes those not begun, and records each", async () => {
      // Arranged where the School date is not UTC's today, whenever this runs,
      // and hours from midnight either way.
      const utcHour = new Date().getUTCHours();
      const world = await arrange(utcHour < 11 ? "Etc/GMT+12" : "Pacific/Kiritimati");
      const { today } = world;
      expect(today).not.toBe(new Date().toISOString().slice(0, 10));
      const running = await assign(world.alice, world.offering, {
        personId: world.frankiePerson.id,
      });
      const upcoming = await assign(world.alice, world.nextOffering, {
        personId: world.frankiePerson.id,
      });
      const over = await assign(world.alice, world.pastOffering, {
        personId: world.frankiePerson.id,
      });
      const coTeaching = await assign(world.alice, world.offering, {
        personId: world.flynnPerson.id,
      });
      const membership = await membershipOf(world.alice, world.frankiePerson, "faculty");
      // A role of Frankie's own that is not Faculty ends nothing.
      await server().grantMembership({
        person: world.frankiePerson,
        role: "guardian",
      });
      const guardian = await membershipOf(world.alice, world.frankiePerson, "guardian");
      expect((await world.alice.delete(`/memberships/${guardian.id}`)).status).toBe(200);

      const consequences = await world.alice.get(`/memberships/${membership.id}/consequences`);
      const revoked = await world.alice.delete(`/memberships/${membership.id}`, { reason: "Left the School" });

      expect(consequences.body).toEqual({
        consequences: { teachingAssignments: 2 },
      });
      expect(revoked.status).toBe(200);
      // Listed by when each begins, then by name.
      expect(await assignmentsOn(world.alice, world.offering)).toEqual([coTeaching, { ...running, lastDate: today }]);
      expect(await assignmentsOn(world.alice, world.nextOffering)).toEqual([]);
      expect(await assignmentsOn(world.alice, world.pastOffering)).toEqual([over]);
      const values = {
        classOfferingId: world.offering.id,
        personId: world.frankiePerson.id,
        firstDate: running.firstDate,
      };
      expect(await trailOf(world.alice, "teaching_assignment.ended", "teaching_assignment.deleted")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "teaching_assignment.ended",
            actorPersonId: world.aliceId,
            target: { type: "teaching_assignment", id: running.id },
            reason: "Left the School",
            before: { ...values, lastDate: null },
            after: { ...values, lastDate: today },
          }),
          expect.objectContaining({
            action: "teaching_assignment.deleted",
            target: { type: "teaching_assignment", id: upcoming.id },
            reason: "Left the School",
            after: null,
          }),
        ]),
      );
      expect(await trailOf(world.alice, "teaching_assignment.ended", "teaching_assignment.deleted")).toHaveLength(2);

      // Its record can still be corrected within its bounds, but not extended.
      const path = `/teaching-assignments/${running.id}`;
      const corrected = await world.alice.patch(path, { firstDate: shifted(running.firstDate, 1) });
      const extended = [
        await world.alice.patch(path, { lastDate: shifted(today, 1) }),
        await world.alice.patch(path, { firstDate: running.firstDate }),
      ];
      expect(corrected.status).toBe(200);
      expect(extended.map((response) => response.status)).toEqual([400, 400]);
    });

    it("by narrowing it ends them on the School date the end falls on, either side of midnight in New York", async () => {
      const world = await arrange();
      // A year well after this one, whose Term runs through March 2040. New York
      // keeps Eastern Standard Time until 11 March that year: midnight is 05:00 UTC.
      const [later] = await divide(world.alice, [{ name: "2040", firstDate: "2040-01-01", lastDate: "2040-06-30" }]);
      const laterOffering = await offer(world.alice, await createCourse(world.alice, "Biology"), later!);
      const running = await assign(world.alice, laterOffering, {
        personId: world.frankiePerson.id,
      });
      const flynns = await assign(world.alice, world.offering, {
        personId: world.flynnPerson.id,
        lastDate: world.current.firstDate,
      });
      const membership = await membershipOf(world.alice, world.frankiePerson, "faculty");
      const narrow = (endsAt: string) =>
        world.alice.patch(`/memberships/${membership.id}`, {
          endsAt,
          reason: "Contract ends",
        });

      const counted = [
        await world.alice.get(`/memberships/${membership.id}/consequences?endsAt=2040-03-07T05:00:00Z`),
        await world.alice.get(`/memberships/${membership.id}/consequences?endsAt=2041-01-01T00:00:00Z`),
      ];
      const atMidnight = await narrow("2040-03-07T05:00:00Z");
      const afterMidnight = (await assignmentsOn(world.alice, laterOffering))[0];
      const justBefore = await narrow("2040-03-07T04:59:59.999Z");

      expect(counted.map((response) => response.body)).toEqual([
        { consequences: { teachingAssignments: 1 } },
        { consequences: { teachingAssignments: 0 } },
      ]);
      expect([atMidnight.status, justBefore.status]).toEqual([200, 200]);
      expect(afterMidnight).toEqual({ ...running, lastDate: "2040-03-07" });
      expect(await assignmentsOn(world.alice, laterOffering)).toEqual([{ ...running, lastDate: "2040-03-06" }]);
      // Flynn's membership was not the one narrowed.
      expect(await assignmentsOn(world.alice, world.offering)).toEqual([flynns]);
      expect(
        (await trailOf(world.alice, "teaching_assignment.ended")).map(
          (record) => (record.after as { lastDate: string }).lastDate,
        ),
      ).toEqual(["2040-03-06", "2040-03-07"]);
    });

    it("takes an end named as a School date to be midnight on it in New York, and ends them on that date", async () => {
      const world = await arrange();
      // New York keeps Eastern Standard Time until 11 March 2040, and Eastern
      // Daylight Time through July: midnight is 05:00 UTC, then 04:00.
      const [later] = await divide(world.alice, [{ name: "2040", firstDate: "2040-01-01", lastDate: "2040-06-30" }]);
      const laterOffering = await offer(world.alice, await createCourse(world.alice, "Biology"), later!);
      const running = await assign(world.alice, laterOffering, { personId: world.frankiePerson.id });
      const membership = await membershipOf(world.alice, world.frankiePerson, "faculty");

      const counted = [
        await world.alice.get(`/memberships/${membership.id}/consequences?endsOn=2040-03-07`),
        await world.alice.get(`/memberships/${membership.id}/consequences?endsOn=2040-07-01`),
      ];
      const granted = await world.alice.post("/memberships", {
        personId: world.frankiePerson.id,
        role: "guardian",
        endsOn: "2040-07-04",
      });
      const narrowed = await world.alice.patch(`/memberships/${membership.id}`, { endsOn: "2040-03-07" });

      expect(counted.map((response) => response.body)).toEqual([
        { consequences: { teachingAssignments: 1 } },
        { consequences: { teachingAssignments: 0 } },
      ]);
      expect(granted.body).toMatchObject({ membership: { endsAt: "2040-07-04T04:00:00.000Z" } });
      expect(narrowed.body).toEqual({ membership: { ...membership, endsAt: "2040-03-07T05:00:00.000Z" } });
      expect(await assignmentsOn(world.alice, laterOffering)).toEqual([{ ...running, lastDate: "2040-03-07" }]);
    });

    it.each([
      ["a date that is not one", { endsOn: "2040-02-30" }],
      ["an instant for a date", { endsOn: "2040-03-07T05:00:00Z" }],
      ["both an instant and a date", { endsAt: "2040-03-07T05:00:00Z", endsOn: "2040-03-07" }],
    ])("refuses %s as an end, and changes nothing", async (_case, end) => {
      const world = await arrange();
      const membership = await membershipOf(world.alice, world.frankiePerson, "faculty");
      const query = new URLSearchParams(end).toString();

      const counted = await world.alice.get(`/memberships/${membership.id}/consequences?${query}`);
      const granted = await world.alice.post("/memberships", {
        personId: world.frankiePerson.id,
        role: "guardian",
        ...end,
      });
      const narrowed = await world.alice.patch(`/memberships/${membership.id}`, end);

      expect([counted.status, granted.status, narrowed.status]).toEqual([400, 400, 400]);
      expect(await membershipOf(world.alice, world.frankiePerson, "faculty")).toEqual(membership);
    });

    it("counts nothing for a membership that is not Faculty, and refuses a malformed end", async () => {
      const world = await arrange();
      const alice = await membershipOf(world.alice, { id: world.aliceId } as Person, "school_administrator");

      const counted = await world.alice.get(`/memberships/${alice.id}/consequences`);
      const malformed = await world.alice.get(`/memberships/${alice.id}/consequences?endsAt=soon`);

      expect(counted.body).toEqual({
        consequences: { teachingAssignments: 0 },
      });
      expect(malformed.status).toBe(400);
    });
  });

  describe("what an assignment holds in place", () => {
    it("refuses a Term bound change or Class Offering deletion that would strand one, naming it", async () => {
      const world = await arrange();
      const { past, current, next } = world;
      await assign(world.alice, world.offering, {
        personId: world.frankiePerson.id,
        lastDate: current.lastDate,
      });
      const before = await stored();
      const year = (
        (await world.alice.get("/academic-years")).body as {
          academicYears: { id: string }[];
        }
      ).academicYears[0]!;

      const shrunk = await world.alice.patch(`/academic-years/${year.id}`, {
        terms: [
          {
            id: past.id,
            name: past.name,
            firstDate: past.firstDate,
            lastDate: past.lastDate,
          },
          {
            id: current.id,
            name: current.name,
            firstDate: current.firstDate,
            lastDate: shifted(current.lastDate, -1),
          },
          {
            id: next.id,
            name: next.name,
            firstDate: shifted(next.firstDate, -1),
            lastDate: next.lastDate,
          },
        ],
      });
      const deleted = await world.alice.delete(`/class-offerings/${world.offering.id}`);
      // Moving the Term's other bound, which strands nothing, is still a change it may take.
      const grown = await world.alice.patch(`/academic-years/${year.id}`, {
        terms: [
          {
            id: past.id,
            name: past.name,
            firstDate: past.firstDate,
            lastDate: shifted(past.lastDate, -1),
          },
          {
            id: current.id,
            name: current.name,
            firstDate: shifted(current.firstDate, -1),
            lastDate: current.lastDate,
          },
          {
            id: next.id,
            name: next.name,
            firstDate: next.firstDate,
            lastDate: next.lastDate,
          },
        ],
      });

      for (const response of [shrunk, deleted]) {
        expect(response.status).toBe(409);
        expect(response.body).toEqual({
          status: "conflict",
          conflict: "dependent",
          dependent: "teaching_assignment",
        });
      }
      expect(grown.status).toBe(200);
      expect(await stored()).toEqual(before);
    });
  });

  describe("reading as Faculty", () => {
    it("reads each Class Offering ever assigned, with its co-teachers, and lists them current first", async () => {
      const world = await arrange();
      const mine = await assign(world.alice, world.offering, {
        personId: world.frankiePerson.id,
      });
      const flynns = await assign(world.alice, world.offering, {
        personId: world.flynnPerson.id,
      });
      await assign(world.alice, world.pastOffering, {
        personId: world.frankiePerson.id,
      });
      // Removed before it began, so never held.
      const removed = await assign(world.alice, world.nextOffering, {
        personId: world.frankiePerson.id,
      });
      expect((await world.alice.delete(`/teaching-assignments/${removed.id}`)).status).toBe(200);
      // Flynn's alone, which Frankie never taught.
      const other = await offer(world.alice, await createCourse(world.alice, "Biology"), world.current);
      await assign(world.alice, other, { personId: world.flynnPerson.id });

      const read = await world.frankie.get(`/class-offerings/${world.offering.id}`);
      const classes = await world.frankie.get("/account/class-offerings");
      const refusal = await world.frankie.get(`/persons/${ABSENT_ID}`);
      const refused = [
        await world.frankie.get(`/class-offerings/${other.id}`),
        await world.frankie.get(`/class-offerings/${world.nextOffering.id}`),
        await world.frankie.get(`/class-offerings/${world.westbrookOffering.id}`),
      ];

      expect(read.status).toBe(200);
      expect((read.body as { classOffering: ClassOffering }).classOffering).toEqual({
        ...world.offering,
        teachingAssignments: [flynns, mine],
        rosterMemberships: [],
      });
      expect(classes.status).toBe(200);
      const { current, past } = classes.body as {
        current: ClassOffering[];
        past: ClassOffering[];
      };
      expect(current.map((offering) => offering.id)).toEqual([world.offering.id]);
      expect(past.map((offering) => offering.id)).toEqual([world.pastOffering.id]);
      expect(current[0]!.teachingAssignments).toEqual([flynns, mine]);
      for (const response of refused) {
        expect(observable(response)).toEqual(observable(refusal));
      }
      expect(await trailOf(world.alice, "access.refused")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reason: "forbidden",
            target: { type: "class_offering", id: other.id },
          }),
        ]),
      );
    });

    it("lists no class for Faculty never assigned, and still lists and reads what they taught once their Faculty membership ends", async () => {
      const world = await arrange();
      await assign(world.alice, world.offering, {
        personId: world.frankiePerson.id,
      });
      // Frankie stays in the School as a Guardian.
      await server().grantMembership({
        person: world.frankiePerson,
        role: "guardian",
      });
      const membership = await membershipOf(world.alice, world.frankiePerson, "faculty");
      expect((await world.alice.delete(`/memberships/${membership.id}`)).status).toBe(200);
      const refusal = await world.frankie.get(`/persons/${ABSENT_ID}`);

      const none = await world.flynn.get("/account/class-offerings");
      const read = await world.frankie.get(`/class-offerings/${world.offering.id}`);
      const classes = await world.frankie.get("/account/class-offerings");
      // Alice administers the School but never taught in it.
      const neverTaught = await world.alice.get("/account/class-offerings");

      expect(none.body).toEqual({ current: [], past: [] });
      expect(read.status).toBe(200);
      expect(classes.status).toBe(200);
      const { current, past } = classes.body as { current: ClassOffering[]; past: ClassOffering[] };
      expect([...current, ...past].map((offering) => offering.id)).toEqual([world.offering.id]);
      expect(observable(neverTaught)).toEqual(observable(refusal));
    });

    it("lists a Person who is both Faculty and a Student the Class Offerings they teach and those they are rostered in", async () => {
      const world = await arrange();
      await server().grantMembership({ person: world.frankiePerson, role: "student" });
      await server().enroll(world.frankiePerson);
      await assign(world.alice, world.offering, { personId: world.frankiePerson.id });
      const rostered = await world.alice.post(`/class-offerings/${world.nextOffering.id}/roster-memberships`, {
        personIds: [world.frankiePerson.id],
      });
      expect(rostered.status).toBe(201);

      const taught = await world.frankie.get("/account/class-offerings");
      const rosteredIn = await world.frankie.get("/account/roster-memberships");

      expect((taught.body as { current: ClassOffering[] }).current.map((offering) => offering.id)).toEqual([
        world.offering.id,
      ]);
      const { terms } = rosteredIn.body as { terms: { classOfferings: ClassOffering[] }[] };
      expect(terms.flatMap((term) => term.classOfferings.map((offering) => offering.id))).toEqual([
        world.nextOffering.id,
      ]);
    });
  });

  describe("outside the caller's reach is the standard refusal", () => {
    // One world, every caller and every action tried within it.
    it("refuses every caller but the School Administrator every change, and the lists to all but Faculty", async () => {
      const world = await arrange();
      const assignment = await assign(world.alice, world.offering, {
        personId: world.frankiePerson.id,
      });
      const schoolId = world.northsideId;
      const sam = await server().createAccount(SAM);
      const gina = await server().createAccount(GINA);
      const pat = await server().createAccount(PAT);
      const samPerson = await server().createPerson({
        schoolId,
        displayName: "Sam",
        account: sam,
        role: "student",
      });
      await server().enroll(samPerson);
      await server().createPerson({
        schoolId,
        displayName: "Gina",
        account: gina,
        role: "guardian",
      });
      await server().createPlatformAdministrator({ account: pat });
      const membership = await membershipOf(world.alice, world.frankiePerson, "faculty");
      const before = await stored();
      const absent = await world.frankie.get(`/persons/${ABSENT_ID}`);

      const changes = [
        [
          "assigning",
          (c: TestClient) =>
            c.post(`/class-offerings/${world.offering.id}/teaching-assignments`, { personId: world.flynnPerson.id }),
        ],
        [
          "assigning from a malformed body",
          (c: TestClient) => c.post(`/class-offerings/${world.offering.id}/teaching-assignments`, { personId: 5 }),
        ],
        [
          "changing bounds",
          (c: TestClient) =>
            c.patch(`/teaching-assignments/${assignment.id}`, {
              lastDate: world.today,
            }),
        ],
        ["ending", (c: TestClient) => c.delete(`/teaching-assignments/${assignment.id}`)],
        ["counting consequences", (c: TestClient) => c.get(`/memberships/${membership.id}/consequences`)],
      ] as const;
      const callers = [
        ["a Faculty member", world.frankie],
        ["a Student", (await server().sessionFor(sam)).inSchool(schoolId)],
        ["a Guardian", (await server().sessionFor(gina)).inSchool(schoolId)],
        ["another School's Administrator", world.bob.inSchool(schoolId)],
        ["a Platform Administrator", (await server().sessionFor(pat)).inSchool(schoolId)],
        ["a caller with no session", server().client.inSchool(schoolId)],
      ] as const;

      const answered: string[] = [];
      for (const [caller, as] of callers) {
        const attempts: (readonly [string, (c: TestClient) => ReturnType<TestClient["get"]>])[] = [...changes];
        if (caller !== "a Faculty member") {
          attempts.push(["reading the offering", (c) => c.get(`/class-offerings/${world.offering.id}`)]);
          attempts.push(["listing their classes", (c) => c.get("/account/class-offerings")]);
        }
        for (const [what, attempt] of attempts) {
          const refused = await attempt(as);
          if (!isDeepStrictEqual(observable(refused), observable(absent))) {
            answered.push(`${caller}: ${what} answered ${refused.status}`);
          }
        }
      }

      expect(answered).toEqual([]);
      expect(await stored()).toEqual(before);
    });

    it("refuses a Teaching assignment that does not exist, or is another School's, identically", async () => {
      const world = await arrange();
      const westbrookFaculty = await server().createPerson({
        schoolId: world.westbrookId,
        displayName: "Wes",
        role: "faculty",
      });
      const theirs = await assign(world.bob, world.westbrookOffering, {
        personId: westbrookFaculty.id,
      });
      const before = await stored();
      const refusal = await world.alice.get(`/persons/${ABSENT_ID}`);

      const answered: string[] = [];
      for (const target of [theirs.id, ABSENT_ID, "not-an-identifier"]) {
        for (const response of [
          await world.alice.patch(`/teaching-assignments/${target}`, {
            lastDate: world.today,
          }),
          await world.alice.delete(`/teaching-assignments/${target}`),
        ]) {
          if (!isDeepStrictEqual(observable(response), observable(refusal))) {
            answered.push(`${response.status} for ${target}`);
          }
        }
      }

      expect(answered).toEqual([]);
      expect(await stored()).toEqual(before);
    });
  });

  describe("in the database", () => {
    it("no Teaching assignment refers to another School's offering or Person, even when written directly", async () => {
      const world = await arrange();
      for (const [schoolId, offeringId] of [
        [world.northsideId, world.westbrookOffering.id],
        [world.westbrookId, world.offering.id],
      ]) {
        await expect(
          server().database.query(
            `INSERT INTO app.teaching_assignment (school_id, class_offering_id, faculty_person_id, first_date)
             VALUES ($1, $2, $3, $4)`,
            [schoolId, offeringId, world.frankiePerson.id, world.today],
          ),
        ).rejects.toThrow(/foreign key/);
      }
    });

    it("nothing is assigned, changed, or ended when its Audit record cannot be written", async () => {
      const world = await arrange();
      const assignment = await assign(world.alice, world.offering, {
        personId: world.frankiePerson.id,
      });
      const membership = await membershipOf(world.alice, world.frankiePerson, "faculty");
      const before = await stored();
      await server().ownerDatabase.query("REVOKE INSERT ON app.audit_record FROM schoolgrid_app");

      await world.alice.post(`/class-offerings/${world.offering.id}/teaching-assignments`, {
        personId: world.flynnPerson.id,
      });
      await world.alice.patch(`/teaching-assignments/${assignment.id}`, {
        lastDate: world.today,
      });
      await world.alice.delete(`/teaching-assignments/${assignment.id}`);
      await world.alice.delete(`/memberships/${membership.id}`);

      expect(await stored()).toEqual(before);
    });
  });
});
