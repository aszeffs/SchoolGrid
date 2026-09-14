import { describe, expect, it } from "vitest";
import { observable, useTestServer, type TestClient } from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const SAM = { username: "sam", password: "a different staple entirely" };
const BOB = { username: "bob", password: "yet another staple, longer" };
const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

describe("Schools and Persons", () => {
  const server = useTestServer();

  it("lists the Schools a caller's account reaches, and no others", async () => {
    const alice = await server().createAccount(ALICE);
    const bob = await server().createAccount(BOB);
    const northside = await server().provisionSchool({ name: "Northside", administrator: alice });
    await server().provisionSchool({ name: "Eastfield", administrator: bob });
    const westbrook = await server().provisionSchool({ name: "Westbrook", administrator: bob });
    await server().createPerson({
      schoolId: westbrook.school.id,
      displayName: "Alice Guardian",
      account: alice,
    });

    const caller = await server().signIn(ALICE);
    const response = await caller.get("/schools");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      schools: [
        { id: northside.school.id, name: "Northside" },
        { id: westbrook.school.id, name: "Westbrook" },
      ],
    });
  });

  it("lets a School Administrator read and list the Persons in their School", async () => {
    const alice = await server().createAccount(ALICE);
    const { school, schoolAdministrator } = await server().provisionSchool({
      name: "Northside",
      administrator: alice,
    });
    const student = await server().createPerson({ schoolId: school.id, displayName: "Sam Student" });

    const caller = (await server().signIn(ALICE)).inSchool(school.id);
    const read = await caller.get(`/persons/${student.id}`);
    const listed = await caller.get("/persons");

    expect(read.status).toBe(200);
    expect(read.body).toEqual({ person: { id: student.id, displayName: "Sam Student" } });
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({
      persons: [
        { id: schoolAdministrator.id, displayName: "alice" },
        { id: student.id, displayName: "Sam Student" },
      ],
    });
  });

  it("omits from a listing the Persons a caller may not read, without signalling it", async () => {
    const alice = await server().createAccount(ALICE);
    const sam = await server().createAccount(SAM);
    const { school } = await server().provisionSchool({ name: "Northside", administrator: alice });
    const samPerson = await server().createPerson({
      schoolId: school.id,
      displayName: "Sam Student",
      account: sam,
    });
    await server().createPerson({ schoolId: school.id, displayName: "Other Student" });

    const caller = (await server().signIn(SAM)).inSchool(school.id);
    const listed = await caller.get("/persons");
    const self = await caller.get(`/persons/${samPerson.id}`);

    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ persons: [{ id: samPerson.id, displayName: "Sam Student" }] });
    expect(self.body).toEqual({ person: { id: samPerson.id, displayName: "Sam Student" } });
  });

  it("keeps the same human at two Schools as two unrelated Persons", async () => {
    const alice = await server().createAccount(ALICE);
    const bob = await server().createAccount(BOB);
    const northside = await server().provisionSchool({ name: "Northside", administrator: alice });
    const westbrook = await server().provisionSchool({ name: "Westbrook", administrator: bob });
    const aliceAtWestbrook = await server().createPerson({
      schoolId: westbrook.school.id,
      displayName: "alice",
      account: alice,
    });

    const caller = await server().signIn(ALICE);
    const atNorthside = await caller.inSchool(northside.school.id).get("/persons");
    const atWestbrook = await caller.inSchool(westbrook.school.id).get("/persons");

    expect(atNorthside.body).toEqual({
      persons: [{ id: northside.schoolAdministrator.id, displayName: "alice" }],
    });
    expect(atWestbrook.body).toEqual({
      persons: [{ id: aliceAtWestbrook.id, displayName: "alice" }],
    });
    expect(aliceAtWestbrook.id).not.toBe(northside.schoolAdministrator.id);
  });

  describe("every refusal is the same refusal", () => {
    interface World {
      /** Sam: a Person in Northside with no membership, so no reach beyond themself. */
      sam: TestClient;
      /** Alice: Northside's School Administrator, who may read every Person there. */
      alice: TestClient;
      northsideId: string;
      westbrookId: string;
      classmateId: string;
      westbrookPersonId: string;
    }

    async function arrange(): Promise<World> {
      const alice = await server().createAccount(ALICE);
      const bob = await server().createAccount(BOB);
      const sam = await server().createAccount(SAM);
      const northside = await server().provisionSchool({ name: "Northside", administrator: alice });
      const westbrook = await server().provisionSchool({ name: "Westbrook", administrator: bob });
      await server().createPerson({ schoolId: northside.school.id, displayName: "Sam", account: sam });
      const classmate = await server().createPerson({
        schoolId: northside.school.id,
        displayName: "Classmate",
      });
      return {
        sam: await server().signIn(SAM),
        alice: await server().signIn(ALICE),
        northsideId: northside.school.id,
        westbrookId: westbrook.school.id,
        classmateId: classmate.id,
        westbrookPersonId: westbrook.schoolAdministrator.id,
      };
    }

    it("answers an absent, a cross-School, and a forbidden Person identically", async () => {
      const world = await arrange();
      const inNorthside = world.sam.inSchool(world.northsideId);

      const absent = await inNorthside.get(`/persons/${ABSENT_ID}`);
      const crossSchool = await inNorthside.get(`/persons/${world.westbrookPersonId}`);
      const forbidden = await inNorthside.get(`/persons/${world.classmateId}`);

      expect(absent.status).not.toBe(200);
      expect(observable(crossSchool)).toEqual(observable(absent));
      expect(observable(forbidden)).toEqual(observable(absent));
    });

    it.each([
      ["no session", (w: World) => server().client.inSchool(w.northsideId).get("/persons")],
      ["no Person in the School", (w: World) => w.sam.inSchool(w.westbrookId).get("/persons")],
      ["a School that does not exist", (w: World) => w.sam.inSchool(ABSENT_ID).get("/persons")],
      ["a malformed School identifier", (w: World) => w.sam.inSchool("not-a-uuid").get("/persons")],
      ["a malformed Person identifier", (w: World) => w.sam.inSchool(w.northsideId).get("/persons/1")],
      [
        "reading a Person in a School with no Person there",
        (w: World) => w.sam.inSchool(w.westbrookId).get(`/persons/${w.westbrookPersonId}`),
      ],
      [
        "a School Administrator asking for a Person in another School",
        (w: World) => w.alice.inSchool(w.northsideId).get(`/persons/${w.westbrookPersonId}`),
      ],
      ["listing Schools with no session", () => server().client.get("/schools")],
    ])("answers %s identically to an absent Person", async (_case, attempt) => {
      const world = await arrange();

      const absent = await world.sam.inSchool(world.northsideId).get(`/persons/${ABSENT_ID}`);
      const refused = await attempt(world);

      expect(observable(refused)).toEqual(observable(absent));
    });
  });

  describe("no row can belong to two Schools", () => {
    it("requires every Person to belong to a School", async () => {
      await expect(
        server().database.query("INSERT INTO app.person (display_name) VALUES ('Nobody')"),
      ).rejects.toThrow(/null value in column "school_id"/);
    });

    it("refuses a membership that names one School and a Person from another", async () => {
      const alice = await server().createAccount(ALICE);
      const bob = await server().createAccount(BOB);
      const northside = await server().provisionSchool({ name: "Northside", administrator: alice });
      const westbrook = await server().provisionSchool({ name: "Westbrook", administrator: bob });

      await expect(
        server().database.query(
          `INSERT INTO app.school_membership (school_id, person_id, role)
           VALUES ($1, $2, 'school_administrator')`,
          [northside.school.id, westbrook.schoolAdministrator.id],
        ),
      ).rejects.toThrow(/foreign key/);
    });

    it("lets an account resolve to at most one Person per School", async () => {
      const alice = await server().createAccount(ALICE);
      const { school } = await server().provisionSchool({ name: "Northside", administrator: alice });

      await expect(
        server().createPerson({ schoolId: school.id, displayName: "Alice again", account: alice }),
      ).rejects.toThrow(/duplicate key/);
    });
  });
});
