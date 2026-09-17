import { describe, expect, it } from "vitest";
import { observable, useTestServer, type TestClient } from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const BOB = { username: "bob", password: "yet another staple, longer" };
const SAM = { username: "sam", password: "a different staple entirely" };
const GINA = { username: "gina", password: "a guardian's staple, twice over" };
const FRAN = { username: "fran", password: "a faculty staple, well chosen" };
const PAT = { username: "pat", password: "the platform's own staple" };
const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

interface ListedPerson {
  id: string;
  displayName: string;
  claimed?: boolean;
}

describe("creating Persons", () => {
  const server = useTestServer();

  interface World {
    northsideId: string;
    westbrookId: string;
    aliceId: string;
    /** Alice: Northside's School Administrator. */
    alice: TestClient;
    /** Sam, Gina, and Fran: a Student, a Guardian, and Faculty at Northside, who can sign in. */
    sam: TestClient;
    gina: TestClient;
    fran: TestClient;
    samId: string;
    /** Bob: Westbrook's School Administrator, with no Person at Northside. */
    bob: TestClient;
    /** Pat: a Platform Administrator, whose account also resolves to a Northside School Administrator. */
    pat: TestClient;
  }

  async function arrange(): Promise<World> {
    const alice = await server().createAccount(ALICE);
    const bob = await server().createAccount(BOB);
    const northside = await server().provisionSchool({ name: "Northside", administrator: alice });
    const westbrook = await server().provisionSchool({ name: "Westbrook", administrator: bob });
    const schoolId = northside.school.id;
    const sam = await server().createPerson({
      schoolId,
      displayName: "Sam",
      account: await server().createAccount(SAM),
      role: "student",
    });
    await server().enroll(sam);
    await server().createPerson({
      schoolId,
      displayName: "Gina",
      account: await server().createAccount(GINA),
      role: "guardian",
    });
    await server().createPerson({
      schoolId,
      displayName: "Fran",
      account: await server().createAccount(FRAN),
      role: "faculty",
    });
    const patAccount = await server().createAccount(PAT);
    await server().createPlatformAdministrator({ account: patAccount });
    await server().createPerson({
      schoolId,
      displayName: "Pat",
      account: patAccount,
      role: "school_administrator",
    });
    const inNorthside = async (credentials: typeof ALICE) =>
      (await server().signIn(credentials)).inSchool(schoolId);
    return {
      northsideId: schoolId,
      westbrookId: westbrook.school.id,
      aliceId: northside.schoolAdministrator.id,
      alice: await inNorthside(ALICE),
      sam: await inNorthside(SAM),
      gina: await inNorthside(GINA),
      fran: await inNorthside(FRAN),
      samId: sam.id,
      bob: await inNorthside(BOB),
      pat: await inNorthside(PAT),
    };
  }

  const persons = async () =>
    (await server().ownerDatabase.query("SELECT * FROM app.person ORDER BY id")).rows;

  it("lets a School Administrator create a Person, who is then listed unclaimed", async () => {
    const world = await arrange();

    const created = await world.alice.post("/persons", { displayName: "Riley Student" });

    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      person: { id: expect.any(String), displayName: "Riley Student", claimed: false },
    });
    const { person } = created.body as { person: ListedPerson };
    const listed = (await world.alice.get("/persons")).body as { persons: ListedPerson[] };
    expect(listed.persons).toContainEqual({ id: person.id, displayName: "Riley Student", claimed: false });
    expect((await world.alice.get(`/persons/${person.id}`)).body).toEqual({
      person: { id: person.id, displayName: "Riley Student" },
    });
  });

  it("keeps a created Person invisible to every other School", async () => {
    const world = await arrange();
    const created = await world.alice.post("/persons", { displayName: "Riley Student" });
    const { person } = created.body as { person: ListedPerson };
    const bob = (await server().signIn(BOB)).inSchool(world.westbrookId);

    const listed = (await bob.get("/persons")).body as { persons: ListedPerson[] };
    const read = await bob.get(`/persons/${person.id}`);
    const absent = await bob.get(`/persons/${ABSENT_ID}`);

    expect(listed.persons.map(({ id }) => id)).not.toContain(person.id);
    expect(observable(read)).toEqual(observable(absent));
  });

  it("shows a School Administrator which Persons are claimed", async () => {
    const world = await arrange();
    await world.alice.post("/persons", { displayName: "Riley Student" });

    const listed = (await world.alice.get("/persons")).body as { persons: ListedPerson[] };

    expect(listed.persons.map(({ displayName, claimed }) => [displayName, claimed])).toEqual([
      ["alice", true],
      ["Fran", true],
      ["Gina", true],
      ["Pat", true],
      ["Riley Student", false],
      ["Sam", true],
    ]);
  });

  it.each([
    ["Faculty", (w: World) => w.fran],
    ["a Student", (w: World) => w.sam],
    ["a Guardian", (w: World) => w.gina],
  ])("reveals to %s no Person's claimed state", async (_case, caller) => {
    const world = await arrange();
    await world.alice.post("/persons", { displayName: "Riley Student" });

    const listed = await caller(world).get("/persons");
    const read = await caller(world).get(`/persons/${world.samId}`);

    expect(listed.status).toBe(200);
    expect(listed.raw).not.toContain("claimed");
    expect(read.raw).not.toContain("claimed");
  });

  it("records the creation in the School's Audit records, naming the School Administrator", async () => {
    const world = await arrange();

    const created = await world.alice.post("/persons", { displayName: "Riley Student" });
    const { person } = created.body as { person: ListedPerson };

    const trail = (await world.alice.get("/audit-records")).body as { auditRecords: unknown[] };
    expect(trail.auditRecords[0]).toEqual({
      id: expect.any(String),
      occurredAt: expect.any(String),
      actorPersonId: world.aliceId,
      actorPlatformAdministratorId: null,
      action: "person.created",
      target: { type: "person", id: person.id },
      reason: null,
      before: null,
      after: { displayName: "Riley Student" },
    });
  });

  it("does not create a Person whose Audit record cannot be written", async () => {
    const world = await arrange();
    const before = await persons();
    await server().ownerDatabase.query("REVOKE INSERT ON app.audit_record FROM schoolgrid_app");

    const attempted = await world.alice.post("/persons", { displayName: "Riley Student" });

    expect(attempted.status).toBe(500);
    expect(await persons()).toEqual(before);
  });

  describe("a malformed display name", () => {
    it.each([
      ["an empty display name", { displayName: "" }],
      ["a blank display name", { displayName: "   " }],
      ["a display name over the length bound", { displayName: "x".repeat(201) }],
      ["a display name that is not text", { displayName: 7 }],
      ["no display name", {}],
      ["a field besides the display name", { displayName: "Riley", userAccountId: ABSENT_ID }],
      ["a body that is not an object", ["Riley"]],
    ])("rejects %s, creating nothing", async (_case, body) => {
      const world = await arrange();
      const before = await persons();

      const rejected = await world.alice.post("/persons", body);

      expect(rejected.status).toBe(400);
      expect(rejected.body).toEqual({ status: "invalid_request" });
      expect(await persons()).toEqual(before);
    });

    it("accepts a display name at the length bound", async () => {
      const world = await arrange();

      const created = await world.alice.post("/persons", { displayName: "x".repeat(200) });

      expect(created.status).toBe(201);
    });
  });

  describe("creating Persons outside the caller's reach is the standard refusal", () => {
    it.each([
      ["Faculty", (w: World) => w.fran],
      ["a Student", (w: World) => w.sam],
      ["a Guardian", (w: World) => w.gina],
      ["a School Administrator of another School", (w: World) => w.bob],
      ["a Platform Administrator", (w: World) => w.pat],
      ["a caller with no session", (w: World) => server().client.inSchool(w.northsideId)],
    ])("refuses %s exactly as an absent Person is refused, whatever the body, creating nothing", async (_case, caller) => {
      const world = await arrange();
      const before = await persons();
      const absent = await world.sam.get(`/persons/${ABSENT_ID}`);

      const wellFormed = await caller(world).post("/persons", { displayName: "Riley Student" });
      const malformed = await caller(world).post("/persons", { displayName: "" });

      expect(absent.status).not.toBe(200);
      expect(observable(wellFormed)).toEqual(observable(absent));
      expect(observable(malformed)).toEqual(observable(absent));
      expect(await persons()).toEqual(before);
    });

    it("refuses a School Administrator creating a Person in a School that does not exist", async () => {
      const world = await arrange();
      const alice = await server().signIn(ALICE);

      const refused = await alice.inSchool(ABSENT_ID).post("/persons", { displayName: "Riley Student" });
      const absent = await world.sam.get(`/persons/${ABSENT_ID}`);

      expect(observable(refused)).toEqual(observable(absent));
    });

    it("records each refusal with its true reason", async () => {
      const world = await arrange();
      const body = { displayName: "Riley Student" };

      await world.fran.post("/persons", body);
      await world.sam.post("/persons", body);
      await world.gina.post("/persons", body);
      await world.bob.post("/persons", body);
      await world.pat.post("/persons", body);

      const trail = (await world.alice.get("/audit-records")).body as {
        auditRecords: { action: string; reason: string | null; target: unknown }[];
      };
      const refusals = trail.auditRecords.filter(({ action }) => action === "access.refused");
      expect(refusals.map(({ reason }) => reason)).toEqual([
        "platform-administrator",
        "no-person-in-school",
        "forbidden",
        "forbidden",
        "forbidden",
      ]);
      expect(refusals[2]!.target).toEqual({ type: "school", id: world.northsideId });
    });
  });
});
