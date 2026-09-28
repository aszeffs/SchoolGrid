import { describe, expect, it } from "vitest";
import { observable, useTestServer, type TestClient } from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const BOB = { username: "bob", password: "yet another staple, longer" };
const FRANKIE = { username: "frankie", password: "a faculty member's staple" };
const SAM = { username: "sam", password: "a different staple entirely" };
const GINA = { username: "gina", password: "a guardian's staple, twice over" };
const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

const A_TO_F = ["A", "B", "C", "D", "F"].map((label) => ({ label, description: null }));

interface Scale {
  version: number;
  values: { label: string; description: string | null }[];
}

interface Recorded {
  actorPersonId: string | null;
  action: string;
  target: { type: string; id: string | null };
  reason: string | null;
  before: unknown;
  after: unknown;
}

describe("the Result value scale", () => {
  const server = useTestServer();

  interface World {
    northsideId: string;
    aliceId: string;
    /** Alice: Northside's School Administrator. */
    alice: TestClient;
    /** Bob: Westbrook's School Administrator, and nothing at Northside. */
    bob: TestClient;
    /** Frankie, Sam and Gina: Northside's Faculty member, enrolled Student, and linked Guardian. */
    frankie: TestClient;
    sam: TestClient;
    gina: TestClient;
  }

  async function arrange(): Promise<World> {
    const alice = await server().createAccount(ALICE);
    const bob = await server().createAccount(BOB);
    const frankie = await server().createAccount(FRANKIE);
    const sam = await server().createAccount(SAM);
    const gina = await server().createAccount(GINA);
    const northside = await server().provisionSchool({ name: "Northside", administrator: alice });
    const westbrook = await server().provisionSchool({ name: "Westbrook", administrator: bob });
    const schoolId = northside.school.id;
    await server().createPerson({ schoolId, displayName: "Frankie", account: frankie, role: "faculty" });
    const samPerson = await server().createPerson({ schoolId, displayName: "Sam", account: sam, role: "student" });
    await server().enroll(samPerson);
    const ginaPerson = await server().createPerson({ schoolId, displayName: "Gina", account: gina, role: "guardian" });
    const aliceClient = (await server().sessionFor(alice)).inSchool(schoolId);
    const linked = await aliceClient.post("/guardian-links", {
      guardianPersonId: ginaPerson.id,
      studentPersonId: samPerson.id,
      accessProfile: { attendanceRead: true, resultsRead: true },
    });
    expect(linked.status).toBe(201);
    return {
      northsideId: schoolId,
      aliceId: northside.schoolAdministrator.id,
      alice: aliceClient,
      bob: (await server().sessionFor(bob)).inSchool(westbrook.school.id),
      frankie: (await server().sessionFor(frankie)).inSchool(schoolId),
      sam: (await server().sessionFor(sam)).inSchool(schoolId),
      gina: (await server().sessionFor(gina)).inSchool(schoolId),
    };
  }

  async function scaleOf(client: TestClient): Promise<Scale> {
    const response = await client.get("/result-value-scale");
    expect(response.status).toBe(200);
    return (response.body as { resultValueScale: Scale }).resultValueScale;
  }

  async function trailOf(admin: TestClient): Promise<Recorded[]> {
    const response = await admin.get("/audit-records");
    expect(response.status).toBe(200);
    return (response.body as { auditRecords: Recorded[] }).auditRecords.filter(
      (record) => record.action === "result_value_scale.saved",
    );
  }

  /** Every version a School holds, oldest first, as the database stores them. */
  async function versionsOf(schoolId: string) {
    const { rows } = await server().ownerDatabase.query<{ number: number; labels: string[] }>(
      `SELECT version.number, array_agg(value.label ORDER BY value.position) AS labels
       FROM app.result_value_scale_version version
       JOIN app.result_value value ON value.scale_version_id = version.id
       WHERE version.school_id = $1
       GROUP BY version.number
       ORDER BY version.number`,
      [schoolId],
    );
    return rows;
  }

  describe("reading", () => {
    it("starts every new School with a first version holding A, B, C, D and F", async () => {
      const world = await arrange();

      expect(await scaleOf(world.alice)).toEqual({ version: 1, values: A_TO_F });
      expect(await scaleOf(world.bob)).toEqual({ version: 1, values: A_TO_F });
    });

    it("is read by a Faculty member as well as a School Administrator", async () => {
      const world = await arrange();

      expect(await scaleOf(world.frankie)).toEqual({ version: 1, values: A_TO_F });
    });
  });

  describe("saving", () => {
    const EXCELLENT = [
      { label: "Excellent", description: "Beyond what the course asks" },
      { label: "Good", description: null },
      { label: "Needs work", description: "Short of what the course asks" },
    ];

    it("saves the values in their order as a new version, keeping the previous one", async () => {
      const world = await arrange();

      const response = await world.alice.post("/result-value-scale", { values: EXCELLENT });

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ resultValueScale: { version: 2, values: EXCELLENT } });
      expect(await scaleOf(world.frankie)).toEqual({ version: 2, values: EXCELLENT });
      expect(await versionsOf(world.northsideId)).toEqual([
        { number: 1, labels: ["A", "B", "C", "D", "F"] },
        { number: 2, labels: ["Excellent", "Good", "Needs work"] },
      ]);
    });

    it("leaves every other School's scale as it was", async () => {
      const world = await arrange();

      await world.alice.post("/result-value-scale", { values: EXCELLENT });

      expect(await scaleOf(world.bob)).toEqual({ version: 1, values: A_TO_F });
    });

    it("takes a value's description as optional, and a scale of one value", async () => {
      const world = await arrange();

      const response = await world.alice.post("/result-value-scale", { values: [{ label: "Pass" }] });

      expect(response.status).toBe(201);
      expect(await scaleOf(world.alice)).toEqual({ version: 2, values: [{ label: "Pass", description: null }] });
    });

    it("records each save with the values before and after, and its reason", async () => {
      const world = await arrange();

      await world.alice.post("/result-value-scale", { values: EXCELLENT, reason: "New policy" });

      expect(await trailOf(world.alice)).toEqual([
        expect.objectContaining({
          actorPersonId: world.aliceId,
          target: { type: "school", id: world.northsideId },
          reason: "New policy",
          before: { version: 1, values: JSON.stringify(A_TO_F) },
          after: { version: 2, values: JSON.stringify(EXCELLENT) },
        }),
      ]);
    });

    it("refuses a save holding exactly the values the current version holds", async () => {
      const world = await arrange();

      const response = await world.alice.post("/result-value-scale", { values: A_TO_F });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ status: "conflict", conflict: "unchanged" });
      expect(await versionsOf(world.northsideId)).toHaveLength(1);
      expect(await trailOf(world.alice)).toEqual([]);
    });

    it.each([
      ["an empty scale", { values: [] }],
      ["two labels the same", { values: [{ label: "Pass" }, { label: "Pass" }] }],
      ["two labels the same but for letter case", { values: [{ label: "Pass" }, { label: "PASS" }] }],
      ["a blank label", { values: [{ label: "" }] }],
      ["a label padded with spaces", { values: [{ label: " A" }] }],
      ["a label longer than 20 characters", { values: [{ label: "x".repeat(21) }] }],
      ["a label that is not text", { values: [{ label: 4 }] }],
      ["a blank description", { values: [{ label: "A", description: "" }] }],
      ["a description longer than 200 characters", { values: [{ label: "A", description: "x".repeat(201) }] }],
      ["a value naming a field there is none of", { values: [{ label: "A", score: 90 }] }],
      ["more than 30 values", { values: Array.from({ length: 31 }, (_, index) => ({ label: `V${index}` })) }],
      ["no values at all", {}],
      ["values that are not a list", { values: { label: "A" } }],
      ["a field there is no setting for", { values: [{ label: "A" }], version: 3 }],
    ])("rejects %s, saving nothing", async (_case, body) => {
      const world = await arrange();

      const response = await world.alice.post("/result-value-scale", body);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ status: "invalid_request" });
      expect(await versionsOf(world.northsideId)).toHaveLength(1);
      expect(await trailOf(world.alice)).toEqual([]);
    });

    it("saves nothing whose Audit record cannot be written", async () => {
      const world = await arrange();
      await server().ownerDatabase.query("REVOKE INSERT ON app.audit_record FROM schoolgrid_app");

      await world.alice.post("/result-value-scale", { values: EXCELLENT });

      expect(await versionsOf(world.northsideId)).toHaveLength(1);
    });

    it("gives two saves made at once a version each", async () => {
      const world = await arrange();

      const saves = await Promise.all([
        world.alice.post("/result-value-scale", { values: [{ label: "Pass" }] }),
        world.alice.post("/result-value-scale", { values: [{ label: "Fail" }] }),
      ]);

      expect(saves.map((save) => save.status)).toEqual([201, 201]);
      expect((await versionsOf(world.northsideId)).map((version) => version.number)).toEqual([1, 2, 3]);
    });
  });

  describe("in the database", () => {
    it("refuses a version with no values, and two labels the same but for letter case", async () => {
      const world = await arrange();
      const database = server().database;

      await expect(
        database.query(`INSERT INTO app.result_value_scale_version (school_id, number) VALUES ($1, 2)`, [
          world.northsideId,
        ]),
      ).rejects.toThrow(/at least one value/);
      await expect(
        database.query(
          `INSERT INTO app.result_value (school_id, scale_version_id, position, label)
           SELECT school_id, id, 6, 'a' FROM app.result_value_scale_version WHERE school_id = $1`,
          [world.northsideId],
        ),
      ).rejects.toThrow(/result_value_label_unique/);
    });

    it("leaves the application unable to change or delete a version or its values", async () => {
      const world = await arrange();
      const database = server().database;

      for (const sql of [
        "UPDATE app.result_value SET label = 'Z' WHERE school_id = $1",
        "DELETE FROM app.result_value WHERE school_id = $1",
        "UPDATE app.result_value_scale_version SET number = 9 WHERE school_id = $1",
        "DELETE FROM app.result_value_scale_version WHERE school_id = $1",
      ]) {
        await expect(database.query(sql, [world.northsideId]), sql).rejects.toThrow(/permission denied/);
      }
    });
  });

  describe("outside the caller's reach is the standard refusal", () => {
    const SAVE = { values: [{ label: "Pass" }] };

    it.each([
      ["a Faculty member saving a scale", (w: World) => w.frankie.post("/result-value-scale", SAVE)],
      ["a Faculty member saving a malformed scale", (w: World) => w.frankie.post("/result-value-scale", { values: [] })],
      ["a Student reading the scale", (w: World) => w.sam.get("/result-value-scale")],
      ["a Student saving a scale", (w: World) => w.sam.post("/result-value-scale", SAVE)],
      ["a Guardian reading the scale", (w: World) => w.gina.get("/result-value-scale")],
      ["a Guardian saving a scale", (w: World) => w.gina.post("/result-value-scale", SAVE)],
      [
        "another School's Administrator reading the scale",
        (w: World) => w.bob.inSchool(w.northsideId).get("/result-value-scale"),
      ],
      [
        "another School's Administrator saving a scale",
        (w: World) => w.bob.inSchool(w.northsideId).post("/result-value-scale", SAVE),
      ],
      [
        "a caller with no session reading the scale",
        (w: World) => server().client.inSchool(w.northsideId).get("/result-value-scale"),
      ],
      [
        "a caller with no session saving a scale",
        (w: World) => server().client.inSchool(w.northsideId).post("/result-value-scale", SAVE),
      ],
      ["reading the scale of a School that does not exist", (w: World) => w.bob.inSchool(ABSENT_ID).get("/result-value-scale")],
    ] as const)("refuses %s exactly as an absent Person is refused, saving nothing", async (_case, attempt) => {
      const world = await arrange();

      const refused = await attempt(world);
      const absent = await world.sam.get(`/persons/${ABSENT_ID}`);

      expect(absent.status).not.toBe(200);
      expect(observable(refused)).toEqual(observable(absent));
      expect(await versionsOf(world.northsideId)).toHaveLength(1);
    });
  });
});
