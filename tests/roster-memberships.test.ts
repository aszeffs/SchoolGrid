import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import type { Person } from "../src/identity/index.ts";
import { observable, useTestServer, type TestClient } from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const BOB = { username: "bob", password: "yet another staple, longer" };
const FRANKIE = { username: "frankie", password: "a faculty member's staple" };
const SAM = { username: "sam", password: "a student's staple, first" };
const SKY = { username: "sky", password: "a student's staple, second" };
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

interface Participation {
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
  teachingAssignments?: Participation[];
  rosterMemberships?: Participation[];
}

interface OwnTerm {
  term: Term;
  current: boolean;
  classOfferings: (ClassOffering & { rosterMemberships: { id: string; firstDate: string; lastDate: string | null }[] })[];
}

/** The School date `days` after this one, which may be negative. */
function shifted(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

describe("Roster memberships", () => {
  const server = useTestServer();

  interface World {
    northsideId: string;
    westbrookId: string;
    aliceId: string;
    /** Alice: Northside's School Administrator. */
    alice: TestClient;
    /** Bob: Westbrook's School Administrator, and nothing at Northside. */
    bob: TestClient;
    /** Frankie: Northside's Faculty, assigned to teach the current offering. */
    frankie: TestClient;
    frankiePerson: Person;
    /** Sam and Sky: Northside's Students, each enrolled and signed in. */
    sam: TestClient;
    samPerson: Person;
    sky: TestClient;
    skyPerson: Person;
    /** Stu: a Student Northside holds, never enrolled. */
    stuPerson: Person;
    /** Northside's School date today. */
    today: string;
    /** Northside's year, divided so that one Term is over, one is running today, and one is still to come. */
    past: Term;
    current: Term;
    next: Term;
    /** An offering in each of those Terms, and a second in the current one. */
    pastOffering: ClassOffering;
    offering: ClassOffering;
    otherOffering: ClassOffering;
    nextOffering: ClassOffering;
    /** Westbrook's own offering, for reaching across Schools. */
    westbrookOffering: ClassOffering;
  }

  async function arrange(timezone = "America/New_York"): Promise<World> {
    const aliceAccount = await server().createAccount(ALICE);
    const bobAccount = await server().createAccount(BOB);
    const northside = await server().provisionSchool({ name: "Northside", timezone, administrator: aliceAccount });
    const westbrook = await server().provisionSchool({ name: "Westbrook", administrator: bobAccount });
    const schoolId = northside.school.id;
    const alice = (await server().sessionFor(aliceAccount)).inSchool(schoolId);
    const bob = (await server().sessionFor(bobAccount)).inSchool(westbrook.school.id);
    const frankieAccount = await server().createAccount(FRANKIE);
    const samAccount = await server().createAccount(SAM);
    const skyAccount = await server().createAccount(SKY);
    const frankiePerson = await server().createPerson({
      schoolId,
      displayName: "Frankie",
      account: frankieAccount,
      role: "faculty",
    });
    const samPerson = await server().createPerson({ schoolId, displayName: "Sam", account: samAccount, role: "student" });
    const skyPerson = await server().createPerson({ schoolId, displayName: "Sky", account: skyAccount, role: "student" });
    const stuPerson = await server().createPerson({ schoolId, displayName: "Stu", role: "student" });
    await server().enroll(samPerson);
    await server().enroll(skyPerson);
    const today = ((await alice.get("/school-date")).body as { schoolDate: string }).schoolDate;
    const [past, current, next] = await divide(alice, [
      { name: "Past", firstDate: shifted(today, -200), lastDate: shifted(today, -101) },
      { name: "Current", firstDate: shifted(today, -100), lastDate: shifted(today, 100) },
      { name: "Next", firstDate: shifted(today, 101), lastDate: shifted(today, 200) },
    ]);
    const [westbrookTerm] = await divide(bob, [{ name: "Whole", firstDate: today, lastDate: today }]);
    const algebra = await createCourse(alice, "Algebra I");
    const offering = await offer(alice, algebra, current!);
    const assigned = await alice.post(`/class-offerings/${offering.id}/teaching-assignments`, {
      personId: frankiePerson.id,
    });
    expect(assigned.status).toBe(201);
    return {
      northsideId: schoolId,
      westbrookId: westbrook.school.id,
      aliceId: northside.schoolAdministrator.id,
      alice,
      bob,
      frankie: (await server().sessionFor(frankieAccount)).inSchool(schoolId),
      frankiePerson,
      sam: (await server().sessionFor(samAccount)).inSchool(schoolId),
      samPerson,
      sky: (await server().sessionFor(skyAccount)).inSchool(schoolId),
      skyPerson,
      stuPerson,
      today,
      past: past!,
      current: current!,
      next: next!,
      pastOffering: await offer(alice, algebra, past!),
      offering,
      otherOffering: await offer(alice, await createCourse(alice, "Biology"), current!),
      nextOffering: await offer(alice, algebra, next!),
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
    const response = await admin.post("/class-offerings", { courseId, termId: term.id, label: term.name });
    expect(response.status).toBe(201);
    return (response.body as { classOffering: ClassOffering }).classOffering;
  }

  async function roster(
    admin: TestClient,
    offering: ClassOffering,
    request: { personIds: string[]; firstDate?: string; lastDate?: string | null; reason?: string },
  ): Promise<Participation[]> {
    const response = await admin.post(`/class-offerings/${offering.id}/roster-memberships`, request);
    expect(response.status).toBe(201);
    return (response.body as { rosterMemberships: Participation[] }).rosterMemberships;
  }

  async function rosterOf(reader: TestClient, offering: ClassOffering): Promise<Participation[]> {
    const response = await reader.get(`/class-offerings/${offering.id}`);
    expect(response.status).toBe(200);
    return (response.body as { classOffering: ClassOffering }).classOffering.rosterMemberships!;
  }

  async function enrollmentOf(admin: TestClient, person: Person): Promise<{ id: string; endedAt: string | null }> {
    const response = await admin.get("/enrollments");
    expect(response.status).toBe(200);
    return (response.body as { enrollments: { id: string; studentPersonId: string; endedAt: string | null }[] })
      .enrollments.find((enrollment) => enrollment.studentPersonId === person.id && enrollment.endedAt === null)!;
  }

  async function trailOf(admin: TestClient, ...actions: string[]): Promise<Recorded[]> {
    const response = await admin.get("/audit-records");
    expect(response.status).toBe(200);
    return (response.body as { auditRecords: Recorded[] }).auditRecords.filter((record) =>
      actions.includes(record.action),
    );
  }

  /** Every Roster membership, as the schema owner sees it. */
  async function stored() {
    const { rows } = await server().ownerDatabase.query(
      `SELECT id, school_id, class_offering_id, student_person_id, first_date::text, last_date::text
       FROM app.roster_membership ORDER BY id`,
    );
    return rows;
  }

  describe("rostering", () => {
    it("rosters several Students in one request, bounded by the Term unless told otherwise, and records each", async () => {
      const world = await arrange();
      const { current } = world;

      const response = await world.alice.post(`/class-offerings/${world.offering.id}/roster-memberships`, {
        personIds: [world.skyPerson.id, world.samPerson.id],
        reason: "Timetabling",
      });
      // The same Students in a second class the same Term, from part way through it.
      const partWay = await roster(world.alice, world.otherOffering, {
        personIds: [world.samPerson.id],
        firstDate: shifted(current.firstDate, 10),
        lastDate: shifted(current.lastDate, -10),
      });

      expect(response.status).toBe(201);
      const { rosterMemberships } = response.body as { rosterMemberships: Participation[] };
      expect(rosterMemberships).toEqual([
        { id: expect.any(String), person: { id: world.samPerson.id, displayName: "Sam" }, firstDate: current.firstDate, lastDate: null },
        { id: expect.any(String), person: { id: world.skyPerson.id, displayName: "Sky" }, firstDate: current.firstDate, lastDate: null },
      ]);
      expect(partWay).toEqual([
        {
          id: expect.any(String),
          person: { id: world.samPerson.id, displayName: "Sam" },
          firstDate: shifted(current.firstDate, 10),
          lastDate: shifted(current.lastDate, -10),
        },
      ]);
      expect(await rosterOf(world.alice, world.offering)).toEqual(rosterMemberships);
      const created = await trailOf(world.alice, "roster_membership.created");
      expect(created).toHaveLength(3);
      expect(created).toEqual(
        expect.arrayContaining(
          rosterMemberships.map((membership) =>
            expect.objectContaining({
              actorPersonId: world.aliceId,
              target: { type: "roster_membership", id: membership.id },
              reason: "Timetabling",
              before: null,
              after: {
                classOfferingId: world.offering.id,
                personId: membership.person.id,
                firstDate: current.firstDate,
                lastDate: null,
              },
            }),
          ),
        ),
      );
    });

    it("changes nothing when any one Student cannot be rostered, whatever the reason", async () => {
      const world = await arrange();
      const { current } = world;
      await roster(world.alice, world.offering, {
        personIds: [world.skyPerson.id],
        firstDate: shifted(current.firstDate, 20),
      });
      const before = await stored();
      const refusal = await world.alice.get(`/persons/${ABSENT_ID}`);
      const path = `/class-offerings/${world.offering.id}/roster-memberships`;
      const sam = world.samPerson.id;

      const invalid = [
        await world.alice.post(path, { personIds: [sam, world.stuPerson.id] }),
        await world.alice.post(path, { personIds: [] }),
        await world.alice.post(path, { personIds: sam }),
        await world.alice.post(path, { personIds: [sam, sam] }),
        await world.alice.post(path, { personIds: [sam], lastDate: shifted(current.firstDate, -1), firstDate: current.firstDate }),
        await world.alice.post(path, { personIds: [sam], firstDate: "someday" }),
      ];
      const overlapping = await world.alice.post(path, { personIds: [sam, world.skyPerson.id] });
      const outside = await world.alice.post(path, { personIds: [sam], lastDate: shifted(current.lastDate, 1) });
      const refused = [
        await world.alice.post(path, { personIds: [sam, ABSENT_ID] }),
        await world.alice.post(path, { personIds: [sam, "not-an-identifier"] }),
      ];

      expect(invalid.map((response) => response.status)).toEqual([400, 400, 400, 400, 400, 400]);
      expect(overlapping.status).toBe(409);
      expect(overlapping.body).toEqual({ status: "conflict", conflict: "roster_membership_overlap" });
      expect(outside.body).toEqual({ status: "conflict", conflict: "roster_membership_outside_term" });
      for (const response of refused) {
        expect(observable(response)).toEqual(observable(refusal));
      }
      expect(await stored()).toEqual(before);
    });
  });

  describe("changing and ending", () => {
    it("changes bounds, ends one on today's School date, and deletes one not yet begun, recording each", async () => {
      const world = await arrange();
      const [running] = await roster(world.alice, world.offering, { personIds: [world.samPerson.id] });
      const [upcoming] = await roster(world.alice, world.nextOffering, { personIds: [world.samPerson.id] });

      const moved = await world.alice.patch(`/roster-memberships/${running!.id}`, {
        firstDate: shifted(world.current.firstDate, 5),
        reason: "Joined late",
      });
      const unchanged = await world.alice.patch(`/roster-memberships/${running!.id}`, {});
      const outOfOrder = await world.alice.patch(`/roster-memberships/${running!.id}`, {
        lastDate: shifted(world.current.firstDate, 1),
      });
      const outside = await world.alice.patch(`/roster-memberships/${running!.id}`, {
        firstDate: shifted(world.current.firstDate, -1),
      });
      const ended = await world.alice.delete(`/roster-memberships/${running!.id}`, { reason: "Changed class" });
      const endedAgain = await world.alice.delete(`/roster-memberships/${running!.id}`);
      const removed = await world.alice.delete(`/roster-memberships/${upcoming!.id}`);

      expect(moved.status).toBe(200);
      expect(unchanged.body).toEqual(moved.body);
      expect(outOfOrder.status).toBe(400);
      expect(outside.body).toEqual({ status: "conflict", conflict: "roster_membership_outside_term" });
      const endedMembership = { ...running!, firstDate: shifted(world.current.firstDate, 5), lastDate: world.today };
      expect(ended.body).toEqual({ rosterMembership: endedMembership });
      expect(endedAgain.body).toEqual({ rosterMembership: endedMembership });
      expect(removed.status).toBe(200);
      expect(await rosterOf(world.alice, world.offering)).toEqual([endedMembership]);
      expect(await rosterOf(world.alice, world.nextOffering)).toEqual([]);
      expect(
        (await trailOf(world.alice, "roster_membership.changed", "roster_membership.ended", "roster_membership.deleted")).map(
          ({ action, reason, after }) => [action, reason, after === null ? null : (after as { lastDate: string }).lastDate],
        ),
      ).toEqual([
        ["roster_membership.deleted", null, null],
        ["roster_membership.ended", "Changed class", world.today],
        ["roster_membership.changed", "Joined late", null],
      ]);
    });
  });

  describe("ending an Enrollment", () => {
    it("ends each open membership on the School date it ended, removes those not begun, and records each", async () => {
      const world = await arrange();
      const [over] = await roster(world.alice, world.pastOffering, { personIds: [world.samPerson.id] });
      const [running] = await roster(world.alice, world.offering, { personIds: [world.samPerson.id, world.skyPerson.id] });
      const [upcoming] = await roster(world.alice, world.nextOffering, { personIds: [world.samPerson.id] });
      const enrollment = await enrollmentOf(world.alice, world.samPerson);
      const consequences = `/enrollments/${enrollment.id}/consequences`;

      const counted = await world.alice.get(consequences);
      const ended = await world.alice.delete(`/enrollments/${enrollment.id}`, { reason: "Moved away" });
      const countedAfter = await world.alice.get(consequences);
      // Its record can still be corrected within its bounds, but not extended.
      const path = `/roster-memberships/${running!.id}`;
      const extended = await world.alice.patch(path, { lastDate: null });
      const corrected = await world.alice.patch(path, { firstDate: shifted(running!.firstDate, 1) });
      const rosteredAgain = await world.alice.post(`/class-offerings/${world.otherOffering.id}/roster-memberships`, {
        personIds: [world.samPerson.id],
      });

      expect(counted.body).toEqual({ consequences: { rosterMemberships: 2 } });
      expect(ended.status).toBe(200);
      expect(countedAfter.body).toEqual({ consequences: { rosterMemberships: 0 } });
      expect(await rosterOf(world.alice, world.pastOffering)).toEqual([over]);
      expect(await rosterOf(world.alice, world.nextOffering)).toEqual([]);
      const onRoster = await rosterOf(world.alice, world.offering);
      // Sky's Enrollment was not the one ended.
      expect(onRoster.find((membership) => membership.person.id === world.skyPerson.id)?.lastDate).toBeNull();
      expect(extended.status).toBe(400);
      expect(corrected.status).toBe(200);
      expect(rosteredAgain.status).toBe(400);
      expect(
        (await trailOf(world.alice, "roster_membership.ended", "roster_membership.deleted")).map(
          ({ action, reason, target }) => [action, reason, target.id],
        ),
      ).toEqual(
        expect.arrayContaining([
          ["roster_membership.ended", "Moved away", running!.id],
          ["roster_membership.deleted", "Moved away", upcoming!.id],
        ]),
      );
      expect(
        (await trailOf(world.alice, "roster_membership.ended")).find((record) => record.target.id === running!.id)?.after,
      ).toEqual(expect.objectContaining({ lastDate: world.today }));
    });

    it("ends them on the School date of the instant it ended, in a School just either side of midnight", async () => {
      // A fixed-offset timezone that puts the School within an hour of its
      // midnight now, on the side of it where its date is not UTC's.
      const hour = new Date().getUTCHours();
      const offset = hour <= 11 ? -1 - hour : 24 - hour;
      const world = await arrange(`Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`);
      const [running] = await roster(world.alice, world.offering, { personIds: [world.samPerson.id] });
      const enrollment = await enrollmentOf(world.alice, world.samPerson);

      const ended = await world.alice.delete(`/enrollments/${enrollment.id}`, { reason: "Moved away" });

      const endedAt = new Date((ended.body as { enrollment: { endedAt: string } }).enrollment.endedAt);
      const schoolDate = new Date(endedAt.getTime() + offset * 3_600_000).toISOString().slice(0, 10);
      expect(schoolDate).not.toBe(endedAt.toISOString().slice(0, 10));
      expect(await rosterOf(world.alice, world.offering)).toEqual([{ ...running!, lastDate: schoolDate }]);
    });
  });

  describe("what a membership holds in place", () => {
    it("refuses a Term bound change or Class Offering deletion that would strand one, naming it", async () => {
      const world = await arrange();
      const { past, current, next } = world;
      // An open membership follows its Term's end; one ending on it holds it there.
      await roster(world.alice, world.otherOffering, {
        personIds: [world.samPerson.id],
        lastDate: current.lastDate,
      });
      const before = await stored();
      const year = ((await world.alice.get("/academic-years")).body as { academicYears: { id: string }[] })
        .academicYears[0]!;

      const shrunk = await world.alice.patch(`/academic-years/${year.id}`, {
        terms: [
          { id: past.id, name: past.name, firstDate: past.firstDate, lastDate: past.lastDate },
          { id: current.id, name: current.name, firstDate: current.firstDate, lastDate: shifted(current.lastDate, -1) },
          { id: next.id, name: next.name, firstDate: shifted(next.firstDate, -1), lastDate: next.lastDate },
        ],
      });
      const deleted = await world.alice.delete(`/class-offerings/${world.otherOffering.id}`);

      for (const response of [shrunk, deleted]) {
        expect(response.status).toBe(409);
        expect(response.body).toEqual({ status: "conflict", conflict: "dependent", dependent: "roster_membership" });
      }
      expect(await stored()).toEqual(before);
    });
  });

  describe("reading", () => {
    it("gives a Student their own classes by Term, with who teaches them and not the roster, even once departed", async () => {
      const world = await arrange();
      const [ownNow] = await roster(world.alice, world.offering, { personIds: [world.samPerson.id, world.skyPerson.id] });
      const [ownBefore] = await roster(world.alice, world.pastOffering, {
        personIds: [world.samPerson.id],
        lastDate: shifted(world.past.lastDate, -3),
      });
      await roster(world.alice, world.otherOffering, { personIds: [world.skyPerson.id] });
      const refusal = await world.sam.get(`/persons/${ABSENT_ID}`);

      const listed = await world.sam.get("/account/roster-memberships");
      const read = await world.sam.get(`/class-offerings/${world.offering.id}`);
      const taught = await world.frankie.get(`/class-offerings/${world.offering.id}`);
      const skys = await world.sam.get(`/class-offerings/${world.otherOffering.id}`);
      const enrollment = await enrollmentOf(world.alice, world.samPerson);
      expect((await world.alice.delete(`/enrollments/${enrollment.id}`, { reason: "Graduated" })).status).toBe(200);
      const departed = [
        await world.sam.get("/account/roster-memberships"),
        await world.sam.get(`/class-offerings/${world.pastOffering.id}`),
      ];

      expect(listed.status).toBe(200);
      const { terms } = listed.body as { terms: OwnTerm[] };
      expect(terms.map(({ term, current }) => [term.id, current])).toEqual([
        [world.current.id, true],
        [world.past.id, false],
      ]);
      expect(terms[0]!.classOfferings).toEqual([
        {
          ...world.offering,
          teachingAssignments: [expect.objectContaining({ person: { id: world.frankiePerson.id, displayName: "Frankie" } })],
          rosterMemberships: [{ id: ownNow!.id, firstDate: world.current.firstDate, lastDate: null }],
        },
      ]);
      expect(terms[1]!.classOfferings[0]!.rosterMemberships).toEqual([
        { id: ownBefore!.id, firstDate: world.past.firstDate, lastDate: shifted(world.past.lastDate, -3) },
      ]);
      expect(read.status).toBe(200);
      const offering = (read.body as { classOffering: ClassOffering }).classOffering;
      expect(offering.teachingAssignments).toHaveLength(1);
      expect(offering).not.toHaveProperty("rosterMemberships");
      // Faculty teaching it read its roster, by display name and dates alone.
      expect((taught.body as { classOffering: ClassOffering }).classOffering.rosterMemberships).toHaveLength(2);
      expect(observable(skys)).toEqual(observable(refusal));
      expect(departed.map((response) => response.status)).toEqual([200, 200]);
      expect((departed[0]!.body as { terms: OwnTerm[] }).terms).toHaveLength(2);
    });

    it("lists no class for a Student never rostered", async () => {
      const world = await arrange();

      const none = await world.sky.get("/account/roster-memberships");

      expect(none.body).toEqual({ terms: [] });
    });
  });

  describe("outside the caller's reach is the standard refusal", () => {
    // One world, every caller and every action tried within it.
    it("refuses every caller but the School Administrator every change, and Students' reads to all but Students", async () => {
      const world = await arrange();
      const [membership] = await roster(world.alice, world.offering, { personIds: [world.samPerson.id] });
      const schoolId = world.northsideId;
      const gina = await server().createAccount(GINA);
      const pat = await server().createAccount(PAT);
      const ginaPerson = await server().createPerson({ schoolId, displayName: "Gina", account: gina, role: "guardian" });
      const linked = await world.alice.post("/guardian-links", {
        guardianPersonId: ginaPerson.id,
        studentPersonId: world.samPerson.id,
        accessProfile: { attendanceRead: true, resultsRead: true },
      });
      expect(linked.status).toBe(201);
      await server().createPlatformAdministrator({ account: pat });
      const enrollment = await enrollmentOf(world.alice, world.samPerson);
      const before = await stored();
      const absent = await world.frankie.get(`/persons/${ABSENT_ID}`);

      const changes = [
        [
          "rostering",
          (c: TestClient) =>
            c.post(`/class-offerings/${world.offering.id}/roster-memberships`, { personIds: [world.skyPerson.id] }),
        ],
        [
          "rostering from a malformed body",
          (c: TestClient) => c.post(`/class-offerings/${world.offering.id}/roster-memberships`, { personIds: 5 }),
        ],
        ["changing bounds", (c: TestClient) => c.patch(`/roster-memberships/${membership!.id}`, { lastDate: world.today })],
        ["ending", (c: TestClient) => c.delete(`/roster-memberships/${membership!.id}`)],
        ["counting consequences", (c: TestClient) => c.get(`/enrollments/${enrollment.id}/consequences`)],
      ] as const;
      const callers = [
        ["a Faculty member", world.frankie],
        ["a Student", world.sam],
        ["another Student", world.sky],
        ["a Guardian", (await server().sessionFor(gina)).inSchool(schoolId)],
        ["another School's Administrator", world.bob.inSchool(schoolId)],
        ["a Platform Administrator", (await server().sessionFor(pat)).inSchool(schoolId)],
        ["a caller with no session", server().client.inSchool(schoolId)],
      ] as const;

      const answered: string[] = [];
      for (const [caller, as] of callers) {
        const attempts: (readonly [string, (c: TestClient) => ReturnType<TestClient["get"]>])[] = [...changes];
        if (caller !== "a Faculty member" && caller !== "a Student") {
          attempts.push(["reading the offering", (c) => c.get(`/class-offerings/${world.offering.id}`)]);
        }
        if (caller !== "a Student" && caller !== "another Student") {
          attempts.push(["listing a Student's classes", (c) => c.get("/account/roster-memberships")]);
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

    it("refuses a Roster membership that does not exist, or is another School's, identically", async () => {
      const world = await arrange();
      const westbrookStudent = await server().createPerson({
        schoolId: world.westbrookId,
        displayName: "Wes",
        role: "student",
      });
      await server().enroll(westbrookStudent);
      const [theirs] = await roster(world.bob, world.westbrookOffering, { personIds: [westbrookStudent.id] });
      const before = await stored();
      const refusal = await world.alice.get(`/persons/${ABSENT_ID}`);

      const answered: string[] = [];
      for (const target of [theirs!.id, ABSENT_ID, "not-an-identifier"]) {
        for (const response of [
          await world.alice.patch(`/roster-memberships/${target}`, { lastDate: world.today }),
          await world.alice.delete(`/roster-memberships/${target}`),
        ]) {
          if (!isDeepStrictEqual(observable(response), observable(refusal))) {
            answered.push(`${response.status} for ${target}`);
          }
        }
      }
      // Nor is another School's Student rostered here, or anyone into another School's offering.
      for (const response of [
        await world.alice.post(`/class-offerings/${world.offering.id}/roster-memberships`, {
          personIds: [westbrookStudent.id],
        }),
        await world.alice.post(`/class-offerings/${world.westbrookOffering.id}/roster-memberships`, {
          personIds: [world.samPerson.id],
        }),
      ]) {
        if (!isDeepStrictEqual(observable(response), observable(refusal))) {
          answered.push(`${response.status} rostering across Schools`);
        }
      }

      expect(answered).toEqual([]);
      expect(await stored()).toEqual(before);
    });
  });

  describe("in the database", () => {
    it("no Roster membership refers to another School's offering or Person, even when written directly", async () => {
      const world = await arrange();
      for (const [schoolId, offeringId] of [
        [world.northsideId, world.westbrookOffering.id],
        [world.westbrookId, world.offering.id],
      ]) {
        await expect(
          server().database.query(
            `INSERT INTO app.roster_membership (school_id, class_offering_id, student_person_id, first_date)
             VALUES ($1, $2, $3, $4)`,
            [schoolId, offeringId, world.samPerson.id, world.today],
          ),
        ).rejects.toThrow(/foreign key/);
      }
    });

    it("nothing is rostered, changed, or ended when its Audit record cannot be written", async () => {
      const world = await arrange();
      const [membership] = await roster(world.alice, world.offering, { personIds: [world.samPerson.id] });
      const enrollment = await enrollmentOf(world.alice, world.samPerson);
      const before = await stored();
      await server().ownerDatabase.query("REVOKE INSERT ON app.audit_record FROM schoolgrid_app");

      await world.alice.post(`/class-offerings/${world.otherOffering.id}/roster-memberships`, {
        personIds: [world.samPerson.id, world.skyPerson.id],
      });
      await world.alice.patch(`/roster-memberships/${membership!.id}`, { lastDate: world.today });
      await world.alice.delete(`/roster-memberships/${membership!.id}`);
      await world.alice.delete(`/enrollments/${enrollment.id}`, { reason: "Moved away" });

      expect(await stored()).toEqual(before);
    });
  });
});
