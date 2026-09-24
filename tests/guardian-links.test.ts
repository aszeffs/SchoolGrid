import { describe, expect, it } from "vitest";
import type { UserAccount } from "../src/authentication/index.ts";
import type { Person } from "../src/identity/index.ts";
import { observable, useTestServer, type TestClient } from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const BOB = { username: "bob", password: "yet another staple, longer" };
const GINA = { username: "gina", password: "a guardian's staple, twice over" };
const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HOUR_MS = 60 * 60 * 1000;

interface Recorded {
  actorPersonId: string | null;
  action: string;
  target: { type: string; id: string | null };
  reason: string | null;
  before: unknown;
  after: unknown;
}

interface GuardianLink {
  id: string;
  guardianPersonId: string;
  studentPersonId: string;
  accessProfile: { attendanceRead: boolean; resultsRead: boolean };
  createdAt: string;
  endedAt: string | null;
}

describe("Guardian links", () => {
  const server = useTestServer();

  interface World {
    northsideId: string;
    westbrookId: string;
    aliceId: string;
    /** Alice: Northside's School Administrator. */
    aliceAdmin: TestClient;
    /** Gina: a Guardian at Northside, linked to no one yet. */
    ginaPerson: Person;
    /** Sam and Sky: two Students at Northside. */
    samPerson: Person;
    skyPerson: Person;
    /** Wren: a Student at Westbrook. */
    wrenPerson: Person;
    bobAdmin: TestClient;
    accounts: Record<"alice" | "gina", UserAccount>;
  }

  async function arrange(): Promise<World> {
    const alice = await server().createAccount(ALICE);
    const bob = await server().createAccount(BOB);
    const gina = await server().createAccount(GINA);
    const northside = await server().provisionSchool({ name: "Northside", administrator: alice });
    const westbrook = await server().provisionSchool({ name: "Westbrook", administrator: bob });
    const ginaPerson = await server().createPerson({
      schoolId: northside.school.id,
      displayName: "Gina",
      account: gina,
      role: "guardian",
    });
    const student = async (schoolId: string, displayName: string) => {
      const person = await server().createPerson({ schoolId, displayName, role: "student" });
      await server().enroll(person);
      return person;
    };
    return {
      northsideId: northside.school.id,
      westbrookId: westbrook.school.id,
      aliceId: northside.schoolAdministrator.id,
      aliceAdmin: (await server().sessionFor(alice)).inSchool(northside.school.id),
      ginaPerson,
      samPerson: await student(northside.school.id, "Sam"),
      skyPerson: await student(northside.school.id, "Sky"),
      wrenPerson: await student(westbrook.school.id, "Wren"),
      bobAdmin: (await server().sessionFor(bob)).inSchool(westbrook.school.id),
      accounts: { alice, gina },
    };
  }

  /** Gina to Sam, reading attendance only. */
  function linkBody(world: World) {
    return {
      guardianPersonId: world.ginaPerson.id,
      studentPersonId: world.samPerson.id,
      accessProfile: { attendanceRead: true, resultsRead: false },
    };
  }

  async function createLink(admin: TestClient, body: object): Promise<GuardianLink> {
    const response = await admin.post("/guardian-links", body);
    expect(response.status).toBe(201);
    return (response.body as { guardianLink: GuardianLink }).guardianLink;
  }

  async function linksOf(admin: TestClient): Promise<GuardianLink[]> {
    const response = await admin.get("/guardian-links");
    expect(response.status).toBe(200);
    return (response.body as { guardianLinks: GuardianLink[] }).guardianLinks;
  }

  async function trailOf(admin: TestClient, action: string): Promise<Recorded[]> {
    const response = await admin.get("/audit-records");
    expect(response.status).toBe(200);
    return (response.body as { auditRecords: Recorded[] }).auditRecords.filter(
      (record) => record.action === action,
    );
  }

  describe("linking", () => {
    it("lets a School Administrator link a Guardian to one specific Student", async () => {
      const world = await arrange();

      const response = await world.aliceAdmin.post("/guardian-links", {
        guardianPersonId: world.ginaPerson.id,
        studentPersonId: world.samPerson.id,
        accessProfile: { attendanceRead: true, resultsRead: false },
      });

      expect(response.status).toBe(201);
      expect(response.body).toEqual({
        guardianLink: {
          id: expect.any(String),
          guardianPersonId: world.ginaPerson.id,
          studentPersonId: world.samPerson.id,
          accessProfile: { attendanceRead: true, resultsRead: false },
          createdAt: expect.stringMatching(ISO_TIMESTAMP),
          endedAt: null,
        },
      });
      const { guardianLink } = response.body as { guardianLink: GuardianLink };
      expect(await linksOf(world.aliceAdmin)).toEqual([guardianLink]);
    });

    it.each([
      { attendanceRead: false, resultsRead: false },
      { attendanceRead: true, resultsRead: false },
      { attendanceRead: false, resultsRead: true },
      { attendanceRead: true, resultsRead: true },
    ])("expresses and persists the Access profile %o", async (accessProfile) => {
      const world = await arrange();

      const link = await createLink(world.aliceAdmin, {
        guardianPersonId: world.ginaPerson.id,
        studentPersonId: world.samPerson.id,
        accessProfile,
      });

      expect(link.accessProfile).toEqual(accessProfile);
      expect(await linksOf(world.aliceAdmin)).toEqual([expect.objectContaining({ accessProfile })]);
    });

    it.each([
      ["no Access profile", (w: World) => ({ guardianPersonId: w.ginaPerson.id, studentPersonId: w.samPerson.id })],
      [
        "a profile missing a permission",
        (w: World) => ({ ...linkBody(w), accessProfile: { attendanceRead: true } }),
      ],
      [
        "a permission that is not true or false",
        (w: World) => ({ ...linkBody(w), accessProfile: { attendanceRead: "yes", resultsRead: false } }),
      ],
      [
        "a named mode instead of permissions",
        (w: World) => ({ ...linkBody(w), accessProfile: "attendance_only" }),
      ],
      [
        "a permission the profile does not have",
        (w: World) => ({ ...linkBody(w), accessProfile: { attendanceRead: true, resultsRead: true, fullRead: true } }),
      ],
      ["no Guardian", (w: World) => ({ ...linkBody(w), guardianPersonId: undefined })],
      ["no Student", (w: World) => ({ ...linkBody(w), studentPersonId: 7 })],
      ["the Student as their own Guardian", (w: World) => ({ ...linkBody(w), guardianPersonId: w.samPerson.id })],
      [
        "a Guardian who holds no Guardian membership",
        (w: World) => ({ ...linkBody(w), guardianPersonId: w.skyPerson.id }),
      ],
      [
        "a Student who holds no Student membership",
        (w: World) => ({ ...linkBody(w), studentPersonId: w.ginaPerson.id, guardianPersonId: w.samPerson.id }),
      ],
      ["a field the link does not have", (w: World) => ({ ...linkBody(w), role: "guardian" })],
    ])("rejects a link with %s, and links nothing", async (_case, body) => {
      const world = await arrange();

      const response = await world.aliceAdmin.post("/guardian-links", body(world));

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ status: "invalid_request" });
      expect(await linksOf(world.aliceAdmin)).toEqual([]);
      expect(await trailOf(world.aliceAdmin, "guardian_link.created")).toEqual([]);
    });

    it("rejects a second link between the same Guardian and Student while one is in force", async () => {
      const world = await arrange();
      const first = await createLink(world.aliceAdmin, linkBody(world));

      const second = await world.aliceAdmin.post("/guardian-links", {
        ...linkBody(world),
        accessProfile: { attendanceRead: false, resultsRead: true },
      });

      expect(second.status).toBe(400);
      expect(await linksOf(world.aliceAdmin)).toEqual([first]);
    });

    it("accepts a Guardian and Student whose memberships have not yet begun", async () => {
      const world = await arrange();
      const later = new Date(Date.now() + HOUR_MS);
      const guardian = await server().createPerson({ schoolId: world.northsideId, displayName: "Gale" });
      const student = await server().createPerson({ schoolId: world.northsideId, displayName: "Scout" });
      await server().grantMembership({ person: guardian, role: "guardian", startsAt: later });
      await server().grantMembership({ person: student, role: "student", startsAt: later });
      await server().enroll(student);

      const response = await world.aliceAdmin.post("/guardian-links", {
        ...linkBody(world),
        guardianPersonId: guardian.id,
        studentPersonId: student.id,
      });

      expect(response.status).toBe(201);
    });

    // A link ends with its Student's Enrollment, so it cannot begin without one.
    it("rejects a Student who holds no open Enrollment", async () => {
      const world = await arrange();
      const unenrolled = await server().createPerson({
        schoolId: world.northsideId,
        displayName: "Uma",
        role: "student",
      });

      const response = await world.aliceAdmin.post("/guardian-links", {
        ...linkBody(world),
        studentPersonId: unenrolled.id,
      });

      expect(response.status).toBe(400);
      expect(await linksOf(world.aliceAdmin)).toEqual([]);
    });

    it("rejects a Guardian whose Guardian membership has ended", async () => {
      const world = await arrange();
      const guardian = await server().createPerson({ schoolId: world.northsideId, displayName: "Gale" });
      await server().grantMembership({
        person: guardian,
        role: "guardian",
        startsAt: new Date(Date.now() - 2 * HOUR_MS),
        endsAt: new Date(Date.now() - HOUR_MS),
      });

      const response = await world.aliceAdmin.post("/guardian-links", {
        ...linkBody(world),
        guardianPersonId: guardian.id,
      });

      expect(response.status).toBe(400);
    });
  });

  describe("changing a profile", () => {
    it("lets a School Administrator change one permission and records the change", async () => {
      const world = await arrange();
      const link = await createLink(world.aliceAdmin, linkBody(world));

      const response = await world.aliceAdmin.patch(`/guardian-links/${link.id}`, {
        accessProfile: { resultsRead: true },
        reason: "Both Guardians now read results",
      });

      const changed = { ...link, accessProfile: { attendanceRead: true, resultsRead: true } };
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ guardianLink: changed });
      expect(await linksOf(world.aliceAdmin)).toEqual([changed]);
      const unchanged = {
        guardianPersonId: world.ginaPerson.id,
        studentPersonId: world.samPerson.id,
        createdAt: link.createdAt,
        endedAt: null,
      };
      expect(await trailOf(world.aliceAdmin, "guardian_link.changed")).toEqual([
        expect.objectContaining({
          actorPersonId: world.aliceId,
          target: { type: "guardian_link", id: link.id },
          reason: "Both Guardians now read results",
          before: { ...unchanged, attendanceRead: true, resultsRead: false },
          after: { ...unchanged, attendanceRead: true, resultsRead: true },
        }),
      ]);
    });

    it("sets both permissions at once", async () => {
      const world = await arrange();
      const link = await createLink(world.aliceAdmin, linkBody(world));

      const response = await world.aliceAdmin.patch(`/guardian-links/${link.id}`, {
        accessProfile: { attendanceRead: false, resultsRead: true },
      });

      expect(response.body).toEqual({
        guardianLink: { ...link, accessProfile: { attendanceRead: false, resultsRead: true } },
      });
    });

    it.each([
      ["no Access profile", {}],
      ["an empty Access profile", { accessProfile: {} }],
      ["a permission that is not true or false", { accessProfile: { resultsRead: 1 } }],
      ["a permission the profile does not have", { accessProfile: { fullRead: true } }],
      ["a different Student", { accessProfile: { resultsRead: true }, studentPersonId: "anyone" }],
    ])("rejects a change with %s, and changes nothing", async (_case, body) => {
      const world = await arrange();
      const link = await createLink(world.aliceAdmin, linkBody(world));

      const response = await world.aliceAdmin.patch(`/guardian-links/${link.id}`, body);

      expect(response.status).toBe(400);
      expect(await linksOf(world.aliceAdmin)).toEqual([link]);
      expect(await trailOf(world.aliceAdmin, "guardian_link.changed")).toEqual([]);
    });

    it("records nothing for a change stating the profile the link already has", async () => {
      const world = await arrange();
      const link = await createLink(world.aliceAdmin, linkBody(world));

      const response = await world.aliceAdmin.patch(`/guardian-links/${link.id}`, {
        accessProfile: { attendanceRead: true },
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ guardianLink: link });
      expect(await trailOf(world.aliceAdmin, "guardian_link.changed")).toEqual([]);
    });

    it("rejects a change to a link that has been revoked", async () => {
      const world = await arrange();
      const link = await createLink(world.aliceAdmin, linkBody(world));
      await world.aliceAdmin.delete(`/guardian-links/${link.id}`);

      const response = await world.aliceAdmin.patch(`/guardian-links/${link.id}`, {
        accessProfile: { resultsRead: true },
      });

      expect(response.status).toBe(400);
      expect(await trailOf(world.aliceAdmin, "guardian_link.changed")).toEqual([]);
    });
  });

  describe("revoking", () => {
    it("lets a School Administrator revoke a link, keeping it as a record", async () => {
      const world = await arrange();
      const link = await createLink(world.aliceAdmin, linkBody(world));

      const response = await world.aliceAdmin.delete(`/guardian-links/${link.id}`, {
        reason: "Custody arrangement changed",
      });

      expect(response.status).toBe(200);
      const revoked = (response.body as { guardianLink: GuardianLink }).guardianLink;
      expect(revoked).toEqual({ ...link, endedAt: expect.stringMatching(ISO_TIMESTAMP) });
      expect(await linksOf(world.aliceAdmin)).toEqual([revoked]);
      const unchanged = {
        guardianPersonId: world.ginaPerson.id,
        studentPersonId: world.samPerson.id,
        attendanceRead: true,
        resultsRead: false,
        createdAt: link.createdAt,
      };
      expect(await trailOf(world.aliceAdmin, "guardian_link.revoked")).toEqual([
        expect.objectContaining({
          actorPersonId: world.aliceId,
          target: { type: "guardian_link", id: link.id },
          reason: "Custody arrangement changed",
          before: { ...unchanged, endedAt: null },
          after: { ...unchanged, endedAt: revoked.endedAt },
        }),
      ]);
    });

    it("records a revocation once, and revoking again changes nothing", async () => {
      const world = await arrange();
      const link = await createLink(world.aliceAdmin, linkBody(world));

      const first = await world.aliceAdmin.delete(`/guardian-links/${link.id}`);
      const second = await world.aliceAdmin.delete(`/guardian-links/${link.id}`);

      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(await trailOf(world.aliceAdmin, "guardian_link.revoked")).toHaveLength(1);
    });

    it("lets the same Guardian and Student be linked afresh once a link is revoked", async () => {
      const world = await arrange();
      const link = await createLink(world.aliceAdmin, linkBody(world));
      await world.aliceAdmin.delete(`/guardian-links/${link.id}`);

      const relinked = await createLink(world.aliceAdmin, linkBody(world));

      expect(relinked.id).not.toBe(link.id);
      expect(await linksOf(world.aliceAdmin)).toHaveLength(2);
    });

    it("rejects a revocation carrying anything but a reason", async () => {
      const world = await arrange();
      const link = await createLink(world.aliceAdmin, linkBody(world));

      const response = await world.aliceAdmin.delete(`/guardian-links/${link.id}`, { endedAt: null });

      expect(response.status).toBe(400);
      expect(await linksOf(world.aliceAdmin)).toEqual([link]);
    });
  });

  describe("a Guardian of two Students", () => {
    async function twoLinks(world: World) {
      const sam = await createLink(world.aliceAdmin, linkBody(world));
      const sky = await createLink(world.aliceAdmin, {
        guardianPersonId: world.ginaPerson.id,
        studentPersonId: world.skyPerson.id,
        accessProfile: { attendanceRead: false, resultsRead: true },
      });
      return { sam, sky };
    }

    it("holds two independent links with their own profiles", async () => {
      const world = await arrange();

      const { sam, sky } = await twoLinks(world);

      expect(sam.id).not.toBe(sky.id);
      expect(await linksOf(world.aliceAdmin)).toEqual([sam, sky]);
    });

    it("keeps one link's profile when the other's changes", async () => {
      const world = await arrange();
      const { sam, sky } = await twoLinks(world);

      await world.aliceAdmin.patch(`/guardian-links/${sam.id}`, {
        accessProfile: { attendanceRead: false, resultsRead: false },
      });

      expect(await linksOf(world.aliceAdmin)).toEqual([
        { ...sam, accessProfile: { attendanceRead: false, resultsRead: false } },
        sky,
      ]);
    });

    it("keeps one link in force when the other is revoked", async () => {
      const world = await arrange();
      const { sam, sky } = await twoLinks(world);

      await world.aliceAdmin.delete(`/guardian-links/${sam.id}`);

      expect(await linksOf(world.aliceAdmin)).toEqual([
        { ...sam, endedAt: expect.stringMatching(ISO_TIMESTAMP) },
        sky,
      ]);
    });
  });

  describe("what a Guardian reaches", () => {
    async function gina(world: World): Promise<TestClient> {
      return (await server().sessionFor(world.accounts.gina)).inSchool(world.northsideId);
    }

    it("reaches the Student they are linked to, and no other", async () => {
      const world = await arrange();
      await createLink(world.aliceAdmin, linkBody(world));
      const guardian = await gina(world);

      const linked = await guardian.get(`/persons/${world.samPerson.id}`);
      const unlinked = await guardian.get(`/persons/${world.skyPerson.id}`);
      const absent = await guardian.get(`/persons/${ABSENT_ID}`);

      expect(linked.status).toBe(200);
      expect(linked.body).toEqual({ person: { id: world.samPerson.id, displayName: "Sam" } });
      expect(absent.status).not.toBe(200);
      expect(observable(unlinked)).toEqual(observable(absent));
    });

    it("lists only themself and the Students they are linked to", async () => {
      const world = await arrange();
      await createLink(world.aliceAdmin, linkBody(world));

      const response = await (await gina(world)).get("/persons");

      expect(response.body).toEqual({
        persons: [
          { id: world.ginaPerson.id, displayName: "Gina" },
          { id: world.samPerson.id, displayName: "Sam" },
        ],
      });
    });

    it("reaches a Student in another School no more than an absent one", async () => {
      const world = await arrange();
      await createLink(world.aliceAdmin, linkBody(world));
      const guardian = await gina(world);

      const elsewhere = await guardian.get(`/persons/${world.wrenPerson.id}`);
      const absent = await guardian.get(`/persons/${ABSENT_ID}`);

      expect(observable(elsewhere)).toEqual(observable(absent));
    });

    it("loses the Student once the link is revoked, and keeps the other Student", async () => {
      const world = await arrange();
      const link = await createLink(world.aliceAdmin, linkBody(world));
      await createLink(world.aliceAdmin, { ...linkBody(world), studentPersonId: world.skyPerson.id });
      const guardian = await gina(world);

      await world.aliceAdmin.delete(`/guardian-links/${link.id}`);

      const absent = await guardian.get(`/persons/${ABSENT_ID}`);
      expect(observable(await guardian.get(`/persons/${world.samPerson.id}`))).toEqual(observable(absent));
      expect((await guardian.get(`/persons/${world.skyPerson.id}`)).status).toBe(200);
    });

    it("reaches no linked Student once their Guardian membership has ended, whatever else they hold", async () => {
      const world = await arrange();
      await createLink(world.aliceAdmin, linkBody(world));
      const memberships = (await world.aliceAdmin.get("/memberships")).body as {
        memberships: { id: string; personId: string; role: string }[];
      };
      const guardianship = memberships.memberships.find((m) => m.personId === world.ginaPerson.id)!;
      await world.aliceAdmin.post("/memberships", { personId: world.ginaPerson.id, role: "faculty" });
      const guardian = await gina(world);

      await world.aliceAdmin.delete(`/memberships/${guardianship.id}`);

      const absent = await guardian.get(`/persons/${ABSENT_ID}`);
      expect(observable(await guardian.get(`/persons/${world.samPerson.id}`))).toEqual(observable(absent));
    });

    // The profile is stored and returned only. Nothing is gated by it yet: the
    // Attendance and Term result slices enforce it.
    it("reaches the linked Student alike whatever the link's Access profile", async () => {
      const world = await arrange();
      await createLink(world.aliceAdmin, {
        ...linkBody(world),
        accessProfile: { attendanceRead: false, resultsRead: false },
      });

      expect((await (await gina(world)).get(`/persons/${world.samPerson.id}`)).status).toBe(200);
    });
  });

  describe("managing Guardian links outside the caller's reach is the standard refusal", () => {
    /** The World's callers, with Gina signed in at Northside and Alice able to address Westbrook. */
    interface Clients extends World {
      aliceIn(schoolId: string): TestClient;
      gina: TestClient;
      samLink: GuardianLink;
      wrenLinkId: string;
    }

    async function clientsFor(world: World): Promise<Clients> {
      const alice = await server().sessionFor(world.accounts.alice);
      const samLink = await createLink(world.aliceAdmin, linkBody(world));
      const westbrookGuardian = await server().createPerson({
        schoolId: world.westbrookId,
        displayName: "Gus",
        role: "guardian",
      });
      const wrenLink = await createLink(world.bobAdmin, {
        guardianPersonId: westbrookGuardian.id,
        studentPersonId: world.wrenPerson.id,
        accessProfile: { attendanceRead: true, resultsRead: true },
      });
      return {
        ...world,
        aliceIn: (schoolId) => alice.inSchool(schoolId),
        gina: (await server().sessionFor(world.accounts.gina)).inSchool(world.northsideId),
        samLink,
        wrenLinkId: wrenLink.id,
      };
    }

    it.each([
      ["listing another School's links", (w: Clients) => w.aliceIn(w.westbrookId).get("/guardian-links")],
      [
        "linking in another School",
        (w: Clients) => w.aliceIn(w.westbrookId).post("/guardian-links", { ...linkBody(w), studentPersonId: w.wrenPerson.id }),
      ],
      [
        "linking a Student from another School",
        (w: Clients) => w.aliceAdmin.post("/guardian-links", { ...linkBody(w), studentPersonId: w.wrenPerson.id }),
      ],
      [
        "linking a Guardian from another School",
        (w: Clients) => w.aliceAdmin.post("/guardian-links", { ...linkBody(w), guardianPersonId: w.wrenPerson.id }),
      ],
      [
        "linking a Student who does not exist",
        (w: Clients) => w.aliceAdmin.post("/guardian-links", { ...linkBody(w), studentPersonId: ABSENT_ID }),
      ],
      [
        "linking a Guardian named by a malformed identifier",
        (w: Clients) => w.aliceAdmin.post("/guardian-links", { ...linkBody(w), guardianPersonId: "1" }),
      ],
      [
        "changing a link in another School",
        (w: Clients) => w.aliceAdmin.patch(`/guardian-links/${w.wrenLinkId}`, { accessProfile: { resultsRead: false } }),
      ],
      ["revoking a link in another School", (w: Clients) => w.aliceAdmin.delete(`/guardian-links/${w.wrenLinkId}`)],
      ["revoking a link that does not exist", (w: Clients) => w.aliceAdmin.delete(`/guardian-links/${ABSENT_ID}`)],
      ["changing a link named by a malformed identifier", (w: Clients) => w.aliceAdmin.patch("/guardian-links/1", {})],
      ["a Guardian listing links", (w: Clients) => w.gina.get("/guardian-links")],
      [
        "a Guardian linking themself to another Student",
        (w: Clients) => w.gina.post("/guardian-links", { ...linkBody(w), studentPersonId: w.skyPerson.id }),
      ],
      [
        "a Guardian widening their own link's profile",
        (w: Clients) => w.gina.patch(`/guardian-links/${w.samLink.id}`, { accessProfile: { resultsRead: true } }),
      ],
      ["a Guardian revoking their own link", (w: Clients) => w.gina.delete(`/guardian-links/${w.samLink.id}`)],
      [
        "a Guardian sending a malformed link",
        (w: Clients) => w.gina.post("/guardian-links", { accessProfile: "full" }),
      ],
      [
        "a Guardian sending a body that is not JSON",
        (w: Clients) => w.gina.postRaw("/guardian-links", "{not json", "application/json"),
      ],
      [
        "a caller with no session linking",
        (w: Clients) => server().client.inSchool(w.northsideId).post("/guardian-links", linkBody(w)),
      ],
    ] as const)("refuses %s exactly as an absent Person is refused, changing nothing", async (_case, attempt) => {
      const world = await arrange();
      const clients = await clientsFor(world);
      const rows = () => server().ownerDatabase.query("SELECT * FROM app.guardian_link ORDER BY id");
      const before = await rows();

      const refused = await attempt(clients);
      const absent = await clients.gina.get(`/persons/${ABSENT_ID}`);

      expect(absent.status).not.toBe(200);
      expect(observable(refused)).toEqual(observable(absent));
      expect((await rows()).rows).toEqual(before.rows);
    });

    it("records a refused attempt with its true reason", async () => {
      const world = await arrange();
      const clients = await clientsFor(world);

      await clients.aliceAdmin.post("/guardian-links", { ...linkBody(world), studentPersonId: world.wrenPerson.id });
      await clients.gina.patch(`/guardian-links/${clients.samLink.id}`, { accessProfile: { resultsRead: true } });

      expect(await trailOf(world.aliceAdmin, "access.refused")).toEqual([
        expect.objectContaining({
          actorPersonId: world.ginaPerson.id,
          reason: "forbidden",
          target: { type: "guardian_link", id: clients.samLink.id },
        }),
        expect.objectContaining({
          actorPersonId: world.aliceId,
          reason: "outside-school",
          target: { type: "person", id: world.wrenPerson.id },
        }),
      ]);
    });

    it("keeps links beyond the application's power to delete or relink", async () => {
      const world = await arrange();
      await createLink(world.aliceAdmin, linkBody(world));
      const database = server().database;

      await expect(database.query("DELETE FROM app.guardian_link")).rejects.toThrow(/permission denied/);
      await expect(
        database.query("UPDATE app.guardian_link SET student_person_id = $1", [world.skyPerson.id]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        database.query("UPDATE app.guardian_link SET created_at = now() - interval '1 year'"),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe("Audit records", () => {
    it("records a link with the acting School Administrator, the link, and the reason", async () => {
      const world = await arrange();

      const link = await createLink(world.aliceAdmin, { ...linkBody(world), reason: "Mother of Sam" });

      expect(await trailOf(world.aliceAdmin, "guardian_link.created")).toEqual([
        {
          id: expect.any(String),
          occurredAt: expect.stringMatching(ISO_TIMESTAMP),
          actorPersonId: world.aliceId,
          actorPlatformAdministratorId: null,
          action: "guardian_link.created",
          target: { type: "guardian_link", id: link.id },
          reason: "Mother of Sam",
          before: null,
          after: {
            guardianPersonId: world.ginaPerson.id,
            studentPersonId: world.samPerson.id,
            attendanceRead: true,
            resultsRead: false,
            createdAt: link.createdAt,
            endedAt: null,
          },
        },
      ]);
    });

    it.each([
      [
        "a link",
        async (world: World) => {
          await world.aliceAdmin.post("/guardian-links", { ...linkBody(world), studentPersonId: world.skyPerson.id });
        },
      ],
      [
        "a change",
        async (world: World, link: GuardianLink) => {
          await world.aliceAdmin.patch(`/guardian-links/${link.id}`, { accessProfile: { resultsRead: true } });
        },
      ],
      [
        "a revocation",
        async (world: World, link: GuardianLink) => {
          await world.aliceAdmin.delete(`/guardian-links/${link.id}`);
        },
      ],
    ])("does not make %s whose Audit record cannot be written", async (_case, attempt) => {
      const world = await arrange();
      const existing = await createLink(world.aliceAdmin, linkBody(world));
      const rows = () => server().ownerDatabase.query("SELECT * FROM app.guardian_link ORDER BY id");
      const before = await rows();
      await server().ownerDatabase.query("REVOKE INSERT ON app.audit_record FROM schoolgrid_app");

      await attempt(world, existing);

      expect((await rows()).rows).toEqual(before.rows);
    });
  });
});
