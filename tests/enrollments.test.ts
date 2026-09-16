import { describe, expect, it } from "vitest";
import type { Person } from "../src/identity/index.ts";
import { observable, useTestServer, type TestClient } from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const BOB = { username: "bob", password: "yet another staple, longer" };
const SAM = { username: "sam", password: "a different staple entirely" };
const GINA = { username: "gina", password: "a guardian's staple, twice over" };
const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HOUR_MS = 60 * 60 * 1000;

interface Enrollment {
  id: string;
  studentPersonId: string;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
}

interface AccessProfile {
  attendanceRead: boolean;
  resultsRead: boolean;
}

interface GuardianLink {
  id: string;
  guardianPersonId: string;
  studentPersonId: string;
  endedAt: string | null;
}

interface Recorded {
  actorPersonId: string | null;
  action: string;
  target: { type: string; id: string | null };
  reason: string | null;
  before: unknown;
  after: unknown;
}

describe("Enrollment", () => {
  const server = useTestServer();

  interface World {
    northsideId: string;
    westbrookId: string;
    aliceId: string;
    /** Alice: Northside's School Administrator. */
    aliceAdmin: TestClient;
    /** Sam and Sky: Students at Northside, not yet enrolled. Sam can sign in. */
    samPerson: Person;
    skyPerson: Person;
    /** Gina: a Guardian at Northside, who can sign in. */
    ginaPerson: Person;
    /** Wren: a Student at Westbrook, enrolled there. */
    wrenPerson: Person;
    wrenEnrollment: Enrollment;
    bobAdmin: TestClient;
  }

  async function arrange(): Promise<World> {
    const alice = await server().createAccount(ALICE);
    const bob = await server().createAccount(BOB);
    const sam = await server().createAccount(SAM);
    const gina = await server().createAccount(GINA);
    const northside = await server().provisionSchool({ name: "Northside", administrator: alice });
    const westbrook = await server().provisionSchool({ name: "Westbrook", administrator: bob });
    const bobAdmin = (await server().signIn(BOB)).inSchool(westbrook.school.id);
    const wrenPerson = await server().createPerson({
      schoolId: westbrook.school.id,
      displayName: "Wren",
      role: "student",
    });
    return {
      northsideId: northside.school.id,
      westbrookId: westbrook.school.id,
      aliceId: northside.schoolAdministrator.id,
      aliceAdmin: (await server().signIn(ALICE)).inSchool(northside.school.id),
      samPerson: await server().createPerson({
        schoolId: northside.school.id,
        displayName: "Sam",
        account: sam,
        role: "student",
      }),
      skyPerson: await server().createPerson({
        schoolId: northside.school.id,
        displayName: "Sky",
        role: "student",
      }),
      ginaPerson: await server().createPerson({
        schoolId: northside.school.id,
        displayName: "Gina",
        account: gina,
        role: "guardian",
      }),
      wrenPerson,
      wrenEnrollment: await enroll(bobAdmin, wrenPerson),
      bobAdmin,
    };
  }

  async function enroll(admin: TestClient, student: Person, reason?: string): Promise<Enrollment> {
    const response = await admin.post("/enrollments", { studentPersonId: student.id, reason });
    expect(response.status).toBe(201);
    return (response.body as { enrollment: Enrollment }).enrollment;
  }

  async function end(admin: TestClient, enrollment: Enrollment, reason = "Transfer"): Promise<Enrollment> {
    const response = await admin.delete(`/enrollments/${enrollment.id}`, { reason });
    expect(response.status).toBe(200);
    return (response.body as { enrollment: Enrollment }).enrollment;
  }

  async function enrollmentsOf(admin: TestClient): Promise<Enrollment[]> {
    const response = await admin.get("/enrollments");
    expect(response.status).toBe(200);
    return (response.body as { enrollments: Enrollment[] }).enrollments;
  }

  async function link(
    admin: TestClient,
    guardian: Person,
    student: Person,
    accessProfile: AccessProfile = { attendanceRead: true, resultsRead: true },
  ): Promise<GuardianLink> {
    const response = await admin.post("/guardian-links", {
      guardianPersonId: guardian.id,
      studentPersonId: student.id,
      accessProfile,
    });
    expect(response.status).toBe(201);
    return (response.body as { guardianLink: GuardianLink }).guardianLink;
  }

  async function linksOf(admin: TestClient): Promise<GuardianLink[]> {
    const response = await admin.get("/guardian-links");
    expect(response.status).toBe(200);
    return (response.body as { guardianLinks: GuardianLink[] }).guardianLinks;
  }

  /** The School's whole trail, newest first. */
  async function auditRecordsOf(admin: TestClient): Promise<Recorded[]> {
    const response = await admin.get("/audit-records");
    expect(response.status).toBe(200);
    return (response.body as { auditRecords: Recorded[] }).auditRecords;
  }

  async function trailOf(admin: TestClient, action: string): Promise<Recorded[]> {
    return (await auditRecordsOf(admin)).filter((record) => record.action === action);
  }

  describe("recording", () => {
    it("lets a School Administrator record a Student's Enrollment", async () => {
      const world = await arrange();

      const response = await world.aliceAdmin.post("/enrollments", {
        studentPersonId: world.samPerson.id,
        reason: "Starting Grade 7",
      });

      expect(response.status).toBe(201);
      expect(response.body).toEqual({
        enrollment: {
          id: expect.any(String),
          studentPersonId: world.samPerson.id,
          startedAt: expect.stringMatching(ISO_TIMESTAMP),
          endedAt: null,
          endReason: null,
        },
      });
      const { enrollment } = response.body as { enrollment: Enrollment };
      expect(await enrollmentsOf(world.aliceAdmin)).toEqual([enrollment]);
      expect(await trailOf(world.aliceAdmin, "enrollment.recorded")).toEqual([
        expect.objectContaining({
          actorPersonId: world.aliceId,
          target: { type: "enrollment", id: enrollment.id },
          reason: "Starting Grade 7",
          before: null,
          after: {
            studentPersonId: world.samPerson.id,
            startedAt: enrollment.startedAt,
            endedAt: null,
          },
        }),
      ]);
    });

    it("gives the enrolled Student access to their own records", async () => {
      const world = await arrange();
      await enroll(world.aliceAdmin, world.samPerson);

      const sam = (await server().signIn(SAM)).inSchool(world.northsideId);

      expect((await sam.get(`/persons/${world.samPerson.id}`)).body).toEqual({
        person: { id: world.samPerson.id, displayName: "Sam" },
      });
    });

    it.each([
      ["no Student", () => ({})],
      ["a Student that is not an identifier", () => ({ studentPersonId: 7 })],
      ["a Person who holds no Student membership", (w: World) => ({ studentPersonId: w.ginaPerson.id })],
      ["a field the Enrollment does not have", (w: World) => ({ studentPersonId: w.samPerson.id, endedAt: null })],
    ])("rejects an Enrollment with %s, and records nothing", async (_case, body) => {
      const world = await arrange();

      const response = await world.aliceAdmin.post("/enrollments", body(world));

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ status: "invalid_request" });
      expect(await enrollmentsOf(world.aliceAdmin)).toEqual([]);
      expect(await trailOf(world.aliceAdmin, "enrollment.recorded")).toEqual([]);
    });

    it("rejects a second Enrollment while one is open", async () => {
      const world = await arrange();
      const first = await enroll(world.aliceAdmin, world.samPerson);

      const second = await world.aliceAdmin.post("/enrollments", { studentPersonId: world.samPerson.id });

      expect(second.status).toBe(400);
      expect(await enrollmentsOf(world.aliceAdmin)).toEqual([first]);
    });

    it("accepts a Student whose Student membership has not yet begun", async () => {
      const world = await arrange();
      const scout = await server().createPerson({ schoolId: world.northsideId, displayName: "Scout" });
      await server().grantMembership({
        person: scout,
        role: "student",
        startsAt: new Date(Date.now() + HOUR_MS),
      });

      const response = await world.aliceAdmin.post("/enrollments", { studentPersonId: scout.id });

      expect(response.status).toBe(201);
    });

    it("rejects a Student whose Student membership has ended", async () => {
      const world = await arrange();
      const former = await server().createPerson({ schoolId: world.northsideId, displayName: "Former" });
      await server().grantMembership({
        person: former,
        role: "student",
        startsAt: new Date(Date.now() - 2 * HOUR_MS),
        endsAt: new Date(Date.now() - HOUR_MS),
      });

      const response = await world.aliceAdmin.post("/enrollments", { studentPersonId: former.id });

      expect(response.status).toBe(400);
    });
  });

  describe("ending", () => {
    it("lets a School Administrator end an Enrollment with a reason, keeping it as a record", async () => {
      const world = await arrange();
      const enrollment = await enroll(world.aliceAdmin, world.samPerson);

      const response = await world.aliceAdmin.delete(`/enrollments/${enrollment.id}`, {
        reason: "Transfer to another district",
      });

      expect(response.status).toBe(200);
      const ended = (response.body as { enrollment: Enrollment }).enrollment;
      expect(ended).toEqual({
        ...enrollment,
        endedAt: expect.stringMatching(ISO_TIMESTAMP),
        endReason: "Transfer to another district",
      });
      expect(await enrollmentsOf(world.aliceAdmin)).toEqual([ended]);
      const unchanged = { studentPersonId: world.samPerson.id, startedAt: enrollment.startedAt };
      expect(await trailOf(world.aliceAdmin, "enrollment.ended")).toEqual([
        expect.objectContaining({
          actorPersonId: world.aliceId,
          target: { type: "enrollment", id: enrollment.id },
          reason: "Transfer to another district",
          before: { ...unchanged, endedAt: null },
          after: { ...unchanged, endedAt: ended.endedAt },
        }),
      ]);
    });

    it.each([
      ["no body", undefined],
      ["no reason", {}],
      ["an empty reason", { reason: "" }],
      ["anything but a reason", { reason: "Transfer", endedAt: null }],
    ])("rejects ending with %s, and ends nothing", async (_case, body) => {
      const world = await arrange();
      const enrollment = await enroll(world.aliceAdmin, world.samPerson);

      const response = await world.aliceAdmin.delete(`/enrollments/${enrollment.id}`, body);

      expect(response.status).toBe(400);
      expect(await enrollmentsOf(world.aliceAdmin)).toEqual([enrollment]);
      expect(await trailOf(world.aliceAdmin, "enrollment.ended")).toEqual([]);
    });

    it("records an ending once, and ending again changes nothing", async () => {
      const world = await arrange();
      const enrollment = await enroll(world.aliceAdmin, world.samPerson);

      const first = await world.aliceAdmin.delete(`/enrollments/${enrollment.id}`, { reason: "Moved away" });
      const second = await world.aliceAdmin.delete(`/enrollments/${enrollment.id}`, { reason: "Again" });

      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(await trailOf(world.aliceAdmin, "enrollment.ended")).toHaveLength(1);
    });

    it("keeps ended Enrollments readable beside a later one", async () => {
      const world = await arrange();
      const prior = await end(world.aliceAdmin, await enroll(world.aliceAdmin, world.samPerson));

      const current = await enroll(world.aliceAdmin, world.samPerson);

      expect(await enrollmentsOf(world.aliceAdmin)).toEqual([prior, current]);
    });

    it("keeps Enrollments beyond the application's power to delete or rewrite", async () => {
      const world = await arrange();
      await end(world.aliceAdmin, await enroll(world.aliceAdmin, world.samPerson));
      const database = server().database;

      await expect(database.query("DELETE FROM app.enrollment")).rejects.toThrow(/permission denied/);
      await expect(
        database.query("UPDATE app.enrollment SET student_person_id = $1", [world.skyPerson.id]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        database.query("UPDATE app.enrollment SET started_at = now() - interval '1 year'"),
      ).rejects.toThrow(/permission denied/);
    });

    // A returning Student is given a new Enrollment; an ended one is never reopened.
    it.each([
      ["reopen", "UPDATE app.enrollment SET ended_at = NULL, end_reason = NULL WHERE ended_at IS NOT NULL"],
      ["rewrite why it ended", "UPDATE app.enrollment SET end_reason = 'Expelled' WHERE ended_at IS NOT NULL"],
      ["move when it ended", "UPDATE app.enrollment SET ended_at = now() + interval '1 year' WHERE ended_at IS NOT NULL"],
    ])("refuses the application any attempt to %s an ended Enrollment", async (_case, statement) => {
      const world = await arrange();
      await end(world.aliceAdmin, await enroll(world.aliceAdmin, world.samPerson));
      const rows = () => server().ownerDatabase.query("SELECT * FROM app.enrollment ORDER BY id");
      const before = await rows();

      await expect(server().database.query(statement)).rejects.toThrow(/ended Enrollment cannot change/);

      expect((await rows()).rows).toEqual(before.rows);
    });
  });

  describe("a departed Student", () => {
    async function departed(world: World): Promise<TestClient> {
      await end(world.aliceAdmin, await enroll(world.aliceAdmin, world.samPerson));
      return (await server().signIn(SAM)).inSchool(world.northsideId);
    }

    it("still reaches the School and their own record", async () => {
      const world = await arrange();

      const sam = await departed(world);

      expect((await sam.get(`/persons/${world.samPerson.id}`)).status).toBe(200);
      expect((await (await server().signIn(SAM)).get("/api/schools")).body).toEqual({
        schools: [{ id: world.northsideId, name: "Northside" }],
      });
    });

    it("reaches no other Student, and lists only themself", async () => {
      const world = await arrange();
      await enroll(world.aliceAdmin, world.skyPerson);

      const sam = await departed(world);

      const other = await sam.get(`/persons/${world.skyPerson.id}`);
      const absent = await sam.get(`/persons/${ABSENT_ID}`);
      expect(absent.status).not.toBe(200);
      expect(observable(other)).toEqual(observable(absent));
      expect((await sam.get("/persons")).body).toEqual({
        persons: [{ id: world.samPerson.id, displayName: "Sam" }],
      });
    });

    // Narrowing is derived from whether an Enrollment is open, when a request
    // arrives. Nothing about the Student's memberships is written to say so.
    it("keeps every membership exactly as it was", async () => {
      const world = await arrange();
      const enrollment = await enroll(world.aliceAdmin, world.samPerson);
      const rows = () => server().ownerDatabase.query("SELECT * FROM app.school_membership ORDER BY id");
      const before = await rows();

      await end(world.aliceAdmin, enrollment);

      expect((await rows()).rows).toEqual(before.rows);
    });

    it("takes no record anywhere: ending answers with the Enrollment alone, and nothing exports", async () => {
      const world = await arrange();
      const enrollment = await enroll(world.aliceAdmin, world.samPerson);

      const response = await world.aliceAdmin.delete(`/enrollments/${enrollment.id}`, { reason: "Transfer" });

      expect(Object.keys(response.body as object)).toEqual(["enrollment"]);
      const absent = await world.aliceAdmin.get(`/persons/${ABSENT_ID}`);
      for (const attempt of [
        world.aliceAdmin.get(`/enrollments/${enrollment.id}/export`),
        world.aliceAdmin.post(`/enrollments/${enrollment.id}/transfer`, {}),
        world.aliceAdmin.get(`/persons/${world.samPerson.id}/records`),
      ]) {
        expect(observable(await attempt)).toEqual(observable(absent));
      }
    });
  });

  describe("Guardians of a departed Student", () => {
    it("ends every Guardian link to that Student, recording each", async () => {
      const world = await arrange();
      const gale = await server().createPerson({
        schoolId: world.northsideId,
        displayName: "Gale",
        role: "guardian",
      });
      const enrollment = await enroll(world.aliceAdmin, world.samPerson);
      const ginaLink = await link(world.aliceAdmin, world.ginaPerson, world.samPerson);
      const galeLink = await link(world.aliceAdmin, gale, world.samPerson);

      const ended = await end(world.aliceAdmin, enrollment, "Moved away");

      expect(await linksOf(world.aliceAdmin)).toEqual([
        { ...ginaLink, endedAt: ended.endedAt },
        { ...galeLink, endedAt: ended.endedAt },
      ]);
      expect(await trailOf(world.aliceAdmin, "guardian_link.ended")).toEqual(
        expect.arrayContaining(
          [ginaLink, galeLink].map((each) =>
            expect.objectContaining({
              actorPersonId: world.aliceId,
              target: { type: "guardian_link", id: each.id },
              reason: "Moved away",
              before: expect.objectContaining({ endedAt: null }),
              after: expect.objectContaining({ endedAt: ended.endedAt }),
            }),
          ),
        ),
      );
      const gina = (await server().signIn(GINA)).inSchool(world.northsideId);
      const absent = await gina.get(`/persons/${ABSENT_ID}`);
      expect(observable(await gina.get(`/persons/${world.samPerson.id}`))).toEqual(observable(absent));
    });

    it("leaves a Guardian of two Students full access to the one who stays", async () => {
      const world = await arrange();
      const samEnrollment = await enroll(world.aliceAdmin, world.samPerson);
      await enroll(world.aliceAdmin, world.skyPerson);
      await link(world.aliceAdmin, world.ginaPerson, world.samPerson);
      const skyLink = await link(world.aliceAdmin, world.ginaPerson, world.skyPerson);

      await end(world.aliceAdmin, samEnrollment);

      expect((await linksOf(world.aliceAdmin)).find((each) => each.id === skyLink.id)).toEqual(skyLink);
      const gina = (await server().signIn(GINA)).inSchool(world.northsideId);
      expect((await gina.get(`/persons/${world.skyPerson.id}`)).status).toBe(200);
      expect((await gina.get("/persons")).body).toEqual({
        persons: [
          { id: world.ginaPerson.id, displayName: "Gina" },
          { id: world.skyPerson.id, displayName: "Sky" },
        ],
      });
    });

    it("cannot be linked to the Student again once they have departed", async () => {
      const world = await arrange();
      await end(world.aliceAdmin, await enroll(world.aliceAdmin, world.samPerson));

      const response = await world.aliceAdmin.post("/guardian-links", {
        guardianPersonId: world.ginaPerson.id,
        studentPersonId: world.samPerson.id,
        accessProfile: { attendanceRead: true, resultsRead: true },
      });

      expect(response.status).toBe(400);
      expect(await linksOf(world.aliceAdmin)).toEqual([]);
    });
  });

  describe("a returning Student", () => {
    /** The records appended to a trail since it read as `earlier`, oldest first. */
    function appendedSince(earlier: Recorded[], now: Recorded[]): Recorded[] {
      const appended = now.length - earlier.length;
      expect(now.slice(appended)).toEqual(earlier);
      return now.slice(0, appended).reverse();
    }

    /** Whether a record describes an Enrollment or Guardian link of this Student. */
    function concerns(record: Recorded, student: Person): boolean {
      return (record.after as { studentPersonId?: string } | null)?.studentPersonId === student.id;
    }

    // Beyond what is asserted here, a returning Student regains their own
    // records that are not published, such as Attendance, and a departed one
    // reads only published ones. No route serves either yet: the Attendance and
    // Term result slices assert it when they add one.
    it("walks Enrollment, departure, and return, widening again with no step but the new Enrollment", async () => {
      const world = await arrange();
      await enroll(world.aliceAdmin, world.skyPerson);
      const sam = (await server().signIn(SAM)).inSchool(world.northsideId);
      const gina = (await server().signIn(GINA)).inSchool(world.northsideId);
      const absentResponse = await sam.get(`/persons/${ABSENT_ID}`);
      expect(absentResponse.status).not.toBe(200);
      const absent = observable(absentResponse);
      const onlySam = { persons: [{ id: world.samPerson.id, displayName: "Sam" }] };

      // Enrolled: Sam reaches their own record and no other Student, and a
      // Guardian linked to Sam reaches them.
      const first = await enroll(world.aliceAdmin, world.samPerson);
      const firstLink = await link(world.aliceAdmin, world.ginaPerson, world.samPerson);
      expect((await sam.get(`/persons/${world.samPerson.id}`)).status).toBe(200);
      expect((await sam.get("/persons")).body).toEqual(onlySam);
      expect(observable(await sam.get(`/persons/${world.skyPerson.id}`))).toEqual(absent);
      expect((await gina.get(`/persons/${world.samPerson.id}`)).status).toBe(200);

      // Departed: Sam keeps their own record and still no other Student. Gina's
      // link has ended with the Enrollment, and no Guardian can be linked anew.
      const ended = await end(world.aliceAdmin, first, "Moved away");
      expect((await sam.get(`/persons/${world.samPerson.id}`)).status).toBe(200);
      expect((await sam.get("/persons")).body).toEqual(onlySam);
      expect(observable(await sam.get(`/persons/${world.skyPerson.id}`))).toEqual(absent);
      expect(observable(await gina.get(`/persons/${world.samPerson.id}`))).toEqual(absent);
      const refusedLink = await world.aliceAdmin.post("/guardian-links", {
        guardianPersonId: world.ginaPerson.id,
        studentPersonId: world.samPerson.id,
        accessProfile: { attendanceRead: true, resultsRead: true },
      });
      expect(refusedLink.status).toBe(400);
      const trailAtDeparture = await auditRecordsOf(world.aliceAdmin);

      // Returned: the same Person is given a new Enrollment, and that is the
      // only change written. The prior Enrollment and its ended link stay as
      // they were.
      const second = await enroll(world.aliceAdmin, world.samPerson, "Returning for Grade 8");
      expect(second.id).not.toBe(first.id);
      expect(second).toEqual({
        id: second.id,
        studentPersonId: world.samPerson.id,
        startedAt: expect.stringMatching(ISO_TIMESTAMP),
        endedAt: null,
        endReason: null,
      });
      expect(appendedSince(trailAtDeparture, await auditRecordsOf(world.aliceAdmin))).toEqual([
        expect.objectContaining({ action: "enrollment.recorded", target: { type: "enrollment", id: second.id } }),
      ]);
      expect(
        (await enrollmentsOf(world.aliceAdmin)).filter((each) => each.studentPersonId === world.samPerson.id),
      ).toEqual([ended, second]);
      expect(await linksOf(world.aliceAdmin)).toEqual([{ ...firstLink, endedAt: ended.endedAt }]);

      // Sam's access is whole again, and still reaches no other Student. Gina's
      // is not: the return restores no link.
      expect((await sam.get(`/persons/${world.samPerson.id}`)).status).toBe(200);
      expect((await sam.get("/persons")).body).toEqual(onlySam);
      expect(observable(await sam.get(`/persons/${world.skyPerson.id}`))).toEqual(absent);
      expect(observable(await gina.get(`/persons/${world.samPerson.id}`))).toEqual(absent);

      // A School Administrator links Gina afresh, with an Access profile of its own.
      const secondLink = await link(world.aliceAdmin, world.ginaPerson, world.samPerson, {
        attendanceRead: true,
        resultsRead: false,
      });
      expect(secondLink.id).not.toBe(firstLink.id);
      expect((await gina.get(`/persons/${world.samPerson.id}`)).status).toBe(200);

      // The trail tells the whole story of Sam's stays, in order.
      const trail = (await auditRecordsOf(world.aliceAdmin)).reverse().filter((record) =>
        concerns(record, world.samPerson),
      );
      expect(trail).toEqual([
        expect.objectContaining({
          action: "enrollment.recorded",
          target: { type: "enrollment", id: first.id },
          before: null,
        }),
        expect.objectContaining({
          action: "guardian_link.created",
          target: { type: "guardian_link", id: firstLink.id },
        }),
        expect.objectContaining({
          action: "enrollment.ended",
          target: { type: "enrollment", id: first.id },
          reason: "Moved away",
          after: expect.objectContaining({ endedAt: ended.endedAt }),
        }),
        expect.objectContaining({
          action: "guardian_link.ended",
          target: { type: "guardian_link", id: firstLink.id },
          reason: "Moved away",
          after: expect.objectContaining({ endedAt: ended.endedAt }),
        }),
        expect.objectContaining({
          actorPersonId: world.aliceId,
          action: "enrollment.recorded",
          target: { type: "enrollment", id: second.id },
          reason: "Returning for Grade 8",
          before: null,
          after: { studentPersonId: world.samPerson.id, startedAt: second.startedAt, endedAt: null },
        }),
        expect.objectContaining({
          action: "guardian_link.created",
          target: { type: "guardian_link", id: secondLink.id },
          after: expect.objectContaining({ attendanceRead: true, resultsRead: false }),
        }),
      ]);
    });

    // Enrolling confers no role, on return as at first: a Student whose Student
    // membership ended while they were away is granted one afresh.
    it("returns after their Student membership ended, once granted a new one", async () => {
      const world = await arrange();
      const sam = (await server().signIn(SAM)).inSchool(world.northsideId);
      const absentResponse = await world.aliceAdmin.get(`/persons/${ABSENT_ID}`);
      expect(absentResponse.status).not.toBe(200);
      await end(world.aliceAdmin, await enroll(world.aliceAdmin, world.samPerson), "Moved away");
      const memberships = (await world.aliceAdmin.get("/memberships")).body as {
        memberships: { id: string; personId: string }[];
      };
      const samMembership = memberships.memberships.find((each) => each.personId === world.samPerson.id)!;
      expect((await world.aliceAdmin.delete(`/memberships/${samMembership.id}`)).status).toBe(200);
      expect(observable(await sam.get(`/persons/${world.samPerson.id}`))).toEqual(observable(absentResponse));

      const withoutMembership = await world.aliceAdmin.post("/enrollments", { studentPersonId: world.samPerson.id });
      const granted = await world.aliceAdmin.post("/memberships", { personId: world.samPerson.id, role: "student" });
      const returned = await world.aliceAdmin.post("/enrollments", { studentPersonId: world.samPerson.id });

      expect(withoutMembership.status).toBe(400);
      expect(granted.status).toBe(201);
      expect(returned.status).toBe(201);
      expect((await sam.get(`/persons/${world.samPerson.id}`)).body).toEqual({
        person: { id: world.samPerson.id, displayName: "Sam" },
      });
    });
  });

  describe("Audit records", () => {
    it.each([
      [
        "an Enrollment",
        async (world: World) => {
          await world.aliceAdmin.post("/enrollments", { studentPersonId: world.skyPerson.id });
        },
      ],
      [
        "an ending, or end its Guardian links,",
        async (world: World, enrollment: Enrollment) => {
          await world.aliceAdmin.delete(`/enrollments/${enrollment.id}`, { reason: "Transfer" });
        },
      ],
    ])("does not record %s whose Audit record cannot be written", async (_case, attempt) => {
      const world = await arrange();
      const existing = await enroll(world.aliceAdmin, world.samPerson);
      await link(world.aliceAdmin, world.ginaPerson, world.samPerson);
      const rows = () =>
        Promise.all(
          ["enrollment", "guardian_link"].map(
            async (table) => (await server().ownerDatabase.query(`SELECT * FROM app.${table} ORDER BY id`)).rows,
          ),
        );
      const before = await rows();
      await server().ownerDatabase.query("REVOKE INSERT ON app.audit_record FROM schoolgrid_app");

      await attempt(world, existing);

      expect(await rows()).toEqual(before);
    });
  });

  describe("managing Enrollments outside the caller's reach is the standard refusal", () => {
    interface Clients extends World {
      aliceIn(schoolId: string): TestClient;
      sam: TestClient;
      gina: TestClient;
      samEnrollment: Enrollment;
    }

    async function clientsFor(world: World): Promise<Clients> {
      const alice = await server().signIn(ALICE);
      return {
        ...world,
        aliceIn: (schoolId) => alice.inSchool(schoolId),
        sam: (await server().signIn(SAM)).inSchool(world.northsideId),
        gina: (await server().signIn(GINA)).inSchool(world.northsideId),
        samEnrollment: await enroll(world.aliceAdmin, world.samPerson),
      };
    }

    it.each([
      ["listing another School's Enrollments", (w: Clients) => w.aliceIn(w.westbrookId).get("/enrollments")],
      [
        "enrolling in another School",
        (w: Clients) => w.aliceIn(w.westbrookId).post("/enrollments", { studentPersonId: w.wrenPerson.id }),
      ],
      [
        "enrolling a Student from another School",
        (w: Clients) => w.aliceAdmin.post("/enrollments", { studentPersonId: w.wrenPerson.id }),
      ],
      [
        "enrolling a Student who does not exist",
        (w: Clients) => w.aliceAdmin.post("/enrollments", { studentPersonId: ABSENT_ID }),
      ],
      [
        "enrolling a Student named by a malformed identifier",
        (w: Clients) => w.aliceAdmin.post("/enrollments", { studentPersonId: "1" }),
      ],
      [
        "ending an Enrollment in another School",
        (w: Clients) => w.aliceAdmin.delete(`/enrollments/${w.wrenEnrollment.id}`, { reason: "Transfer" }),
      ],
      [
        "ending an Enrollment that does not exist",
        (w: Clients) => w.aliceAdmin.delete(`/enrollments/${ABSENT_ID}`, { reason: "Transfer" }),
      ],
      [
        "ending an Enrollment named by a malformed identifier",
        (w: Clients) => w.aliceAdmin.delete("/enrollments/1", { reason: "Transfer" }),
      ],
      ["a Student listing Enrollments", (w: Clients) => w.sam.get("/enrollments")],
      [
        "a Student ending their own Enrollment",
        (w: Clients) => w.sam.delete(`/enrollments/${w.samEnrollment.id}`, { reason: "Leaving" }),
      ],
      [
        "a Student ending their own Enrollment with no reason",
        (w: Clients) => w.sam.delete(`/enrollments/${w.samEnrollment.id}`),
      ],
      [
        "a Guardian enrolling a Student",
        (w: Clients) => w.gina.post("/enrollments", { studentPersonId: w.skyPerson.id }),
      ],
      [
        "a caller with no session enrolling",
        (w: Clients) => server().client.inSchool(w.northsideId).post("/enrollments", { studentPersonId: w.skyPerson.id }),
      ],
    ] as const)("refuses %s exactly as an absent Person is refused, changing nothing", async (_case, attempt) => {
      const world = await arrange();
      const clients = await clientsFor(world);
      const rows = () => server().ownerDatabase.query("SELECT * FROM app.enrollment ORDER BY id");
      const before = await rows();

      const refused = await attempt(clients);
      const absent = await clients.sam.get(`/persons/${ABSENT_ID}`);

      expect(absent.status).not.toBe(200);
      expect(observable(refused)).toEqual(observable(absent));
      expect((await rows()).rows).toEqual(before.rows);
    });

    it("records a refused attempt with its true reason", async () => {
      const world = await arrange();
      const clients = await clientsFor(world);

      await clients.aliceAdmin.post("/enrollments", { studentPersonId: world.wrenPerson.id });
      await clients.sam.delete(`/enrollments/${clients.samEnrollment.id}`, { reason: "Leaving" });

      expect(await trailOf(world.aliceAdmin, "access.refused")).toEqual([
        expect.objectContaining({
          actorPersonId: world.samPerson.id,
          reason: "forbidden",
          target: { type: "enrollment", id: clients.samEnrollment.id },
        }),
        expect.objectContaining({
          actorPersonId: world.aliceId,
          reason: "outside-school",
          target: { type: "person", id: world.wrenPerson.id },
        }),
      ]);
    });
  });
});
