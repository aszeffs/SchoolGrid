import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { UserAccount } from "../src/authentication/index.ts";
import { observable, useTestServer, type TestClient } from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const BOB = { username: "bob", password: "yet another staple, longer" };
const SAM = { username: "sam", password: "a different staple entirely" };
const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

interface Recorded {
  actorPersonId: string | null;
  action: string;
  target: { type: string; id: string | null };
  reason: string | null;
  before: unknown;
  after: unknown;
}

describe("Audit coverage for authentication and refusals", () => {
  const server = useTestServer();

  /** A School's trail as its School Administrator reads it, newest first. */
  async function trailOf(administrator: TestClient, schoolId: string): Promise<Recorded[]> {
    const response = await administrator.inSchool(schoolId).get("/audit-records");
    expect(response.status).toBe(200);
    return (response.body as { auditRecords: Recorded[] }).auditRecords;
  }

  function withAction(trail: Recorded[], action: string): Recorded[] {
    return trail.filter((record) => record.action === action);
  }

  interface World {
    alice: UserAccount;
    bob: UserAccount;
    sam: UserAccount;
    northside: { id: string; aliceId: string; samId: string; classmateId: string };
    eastfield: { id: string; aliceId: string; bobId: string };
    westbrook: { id: string; bobId: string };
  }

  /**
   * Alice administers Northside and is Faculty at Eastfield. Bob
   * administers Eastfield and Westbrook. Sam is a Student at Northside,
   * beside a classmate Sam may not read.
   */
  async function arrange(): Promise<World> {
    const alice = await server().createAccount(ALICE);
    const bob = await server().createAccount(BOB);
    const sam = await server().createAccount(SAM);
    const northside = await server().provisionSchool({ name: "Northside", administrator: alice });
    const eastfield = await server().provisionSchool({ name: "Eastfield", administrator: bob });
    const westbrook = await server().provisionSchool({ name: "Westbrook", administrator: bob });
    const aliceAtEastfield = await server().createPerson({
      schoolId: eastfield.school.id,
      displayName: "Alice",
      account: alice,
      role: "faculty",
    });
    const samPerson = await server().createPerson({
      schoolId: northside.school.id,
      displayName: "Sam",
      account: sam,
      role: "student",
    });
    const classmate = await server().createPerson({
      schoolId: northside.school.id,
      displayName: "Classmate",
    });
    return {
      alice,
      bob,
      sam,
      northside: {
        id: northside.school.id,
        aliceId: northside.schoolAdministrator.id,
        samId: samPerson.id,
        classmateId: classmate.id,
      },
      eastfield: {
        id: eastfield.school.id,
        aliceId: aliceAtEastfield.id,
        bobId: eastfield.schoolAdministrator.id,
      },
      westbrook: { id: westbrook.school.id, bobId: westbrook.schoolAdministrator.id },
    };
  }

  describe("authentication attempts", () => {
    it("records a successful attempt in every School the account reaches, against its Person there", async () => {
      const world = await arrange();

      const alice = await server().signIn(ALICE);
      const bob = await server().signIn(BOB);

      expect(withAction(await trailOf(alice, world.northside.id), "authentication.succeeded")).toEqual([
        {
          actorPersonId: world.northside.aliceId,
          actorPlatformAdministratorId: null,
          action: "authentication.succeeded",
          target: { type: "person", id: world.northside.aliceId },
          reason: null,
          before: null,
          after: null,
          id: expect.any(String),
          occurredAt: expect.any(String),
        },
      ]);
      // Eastfield also sees Alice's sign-in, and Bob's own, each against the Person there.
      expect(
        withAction(await trailOf(bob, world.eastfield.id), "authentication.succeeded").map(
          ({ actorPersonId, target }) => ({ actorPersonId, target }),
        ),
      ).toEqual([
        { actorPersonId: world.eastfield.bobId, target: { type: "person", id: world.eastfield.bobId } },
        { actorPersonId: world.eastfield.aliceId, target: { type: "person", id: world.eastfield.aliceId } },
      ]);
      // Westbrook has no Person for Alice, so it learns nothing of her sign-in.
      expect(withAction(await trailOf(bob, world.westbrook.id), "authentication.succeeded")).toEqual([
        expect.objectContaining({ actorPersonId: world.westbrook.bobId }),
      ]);
    });

    it("records a failed attempt in every School the account reaches, attributing it to no one", async () => {
      const world = await arrange();

      const failed = await server().client.post("/api/session", {
        username: "ALICE",
        password: "not the password",
      });
      expect(failed.status).not.toBe(201);

      const alice = await server().signIn(ALICE);
      const bob = await server().signIn(BOB);
      const atNorthside = await alice.inSchool(world.northside.id).get("/audit-records");
      const northsideFailures = withAction(await trailOf(alice, world.northside.id), "authentication.failed");
      const eastfieldFailures = withAction(await trailOf(bob, world.eastfield.id), "authentication.failed");

      expect(northsideFailures).toEqual([
        expect.objectContaining({
          actorPersonId: null,
          target: { type: "person", id: world.northside.aliceId },
          before: null,
          after: null,
        }),
      ]);
      expect(eastfieldFailures).toEqual([
        expect.objectContaining({ actorPersonId: null, target: { type: "person", id: world.eastfield.aliceId } }),
      ]);
      // The entry names the Person the School already knows, and nothing the
      // caller typed or anything about the account's other Schools.
      expect(atNorthside.raw).not.toMatch(/alice/i);
      expect(atNorthside.raw).not.toContain("not the password");
      expect(atNorthside.raw).not.toContain(world.eastfield.id);
      expect(atNorthside.raw).not.toContain(world.eastfield.aliceId);
      expect(atNorthside.raw).not.toContain(world.alice.id);
    });

    it.each([
      ["an unknown account", { username: "mallory", password: "not the password" }],
      ["a malformed attempt", { username: "alice" }],
    ])("records %s in no School's trail", async (_case, body) => {
      const world = await arrange();

      await server().client.post("/api/session", body);

      const alice = await server().signIn(ALICE);
      const bob = await server().signIn(BOB);
      for (const [administrator, schoolId] of [
        [alice, world.northside.id],
        [bob, world.eastfield.id],
        [bob, world.westbrook.id],
      ] as const) {
        expect(withAction(await trailOf(administrator, schoolId), "authentication.failed")).toEqual([]);
      }
    });

    it("starts no session when its Audit record cannot be written", async () => {
      await arrange();
      await server().ownerDatabase.query("REVOKE INSERT ON app.audit_record FROM schoolgrid_app");

      const attempt = await server().client.withOrigin(server().publicOrigin).post("/api/session", ALICE);

      expect(attempt.status).toBe(500);
      const { rows } = await server().ownerDatabase.query<{ sessions: number }>(
        "SELECT count(*)::int AS sessions FROM app.user_session",
      );
      expect(rows).toEqual([{ sessions: 0 }]);
    });
  });

  describe("refusals", () => {
    it("records the true reason for an absent, a cross-School, and a forbidden Person, and serves none of it", async () => {
      const world = await arrange();
      const sam = (await server().signIn(SAM)).inSchool(world.northside.id);

      const absent = await sam.get(`/persons/${ABSENT_ID}`);
      const crossSchool = await sam.get(`/persons/${world.westbrook.bobId}`);
      const forbidden = await sam.get(`/persons/${world.northside.classmateId}`);

      expect(observable(crossSchool)).toEqual(observable(absent));
      expect(observable(forbidden)).toEqual(observable(absent));
      for (const response of [absent, crossSchool, forbidden]) {
        expect(JSON.stringify(observable(response))).not.toMatch(/absent|outside|forbidden|reason/i);
      }

      const alice = await server().signIn(ALICE);
      expect(withAction(await trailOf(alice, world.northside.id), "access.refused")).toEqual(
        [
          { reason: "absent", id: ABSENT_ID },
          { reason: "outside-school", id: world.westbrook.bobId },
          { reason: "forbidden", id: world.northside.classmateId },
        ]
          .reverse()
          .map(({ reason, id }) =>
            expect.objectContaining({
              actorPersonId: world.northside.samId,
              target: { type: "person", id },
              reason,
            }),
          ),
      );
    });

    it("records a cross-School refusal in the School addressed, never in the School whose record was named", async () => {
      const world = await arrange();
      const alice = await server().signIn(ALICE);
      const bob = await server().signIn(BOB);

      await alice.inSchool(world.northside.id).get(`/persons/${world.westbrook.bobId}`);

      expect(withAction(await trailOf(alice, world.northside.id), "access.refused")).toHaveLength(1);
      expect(withAction(await trailOf(bob, world.westbrook.id), "access.refused")).toEqual([]);
    });

    it("records a caller with no session, without attributing it", async () => {
      const world = await arrange();

      await server().client.inSchool(world.northside.id).get(`/persons/${world.northside.samId}`);

      const alice = await server().signIn(ALICE);
      expect(withAction(await trailOf(alice, world.northside.id), "access.refused")).toEqual([
        expect.objectContaining({
          actorPersonId: null,
          reason: "unauthenticated",
          target: {
            type: "request",
            id: `GET /api/schools/${world.northside.id}/persons/${world.northside.samId}`,
          },
          after: null,
        }),
      ]);
    });

    it("records a caller with no Person in the School by opaque account identifier alone", async () => {
      const world = await arrange();
      const sam = await server().signIn(SAM);

      await sam.inSchool(world.eastfield.id).get("/persons?password=hunter2");

      const bob = await server().signIn(BOB);
      const response = await bob.inSchool(world.eastfield.id).get("/audit-records");
      expect(withAction(await trailOf(bob, world.eastfield.id), "access.refused")).toEqual([
        expect.objectContaining({
          actorPersonId: null,
          reason: "no-person-in-school",
          // The path only: a query string is the caller's to fill with anything.
          target: { type: "request", id: `GET /api/schools/${world.eastfield.id}/persons` },
          after: { userAccountId: world.sam.id },
        }),
      ]);
      expect(response.raw).not.toMatch(/sam|hunter2/i);
    });

    it("records a request for a route that does not exist within a School", async () => {
      const world = await arrange();
      const sam = (await server().signIn(SAM)).inSchool(world.northside.id);

      const unrouted = await sam.get("/no-such-thing");
      const absent = await sam.get(`/persons/${ABSENT_ID}`);

      expect(observable(unrouted)).toEqual(observable(absent));
      const alice = await server().signIn(ALICE);
      expect(withAction(await trailOf(alice, world.northside.id), "access.refused")).toContainEqual(
        expect.objectContaining({
          actorPersonId: world.northside.samId,
          reason: "no-such-route",
          target: { type: "request", id: `GET /api/schools/${world.northside.id}/no-such-thing` },
        }),
      );
    });

    it("bounds an overlong request in the record without changing the refusal", async () => {
      const world = await arrange();
      const sam = (await server().signIn(SAM)).inSchool(world.northside.id);

      const refused = await sam.get(`/persons/${"x".repeat(2000)}`);
      const absent = await sam.get(`/persons/${ABSENT_ID}`);

      expect(observable(refused)).toEqual(observable(absent));
      const alice = await server().signIn(ALICE);
      const [, recorded] = withAction(await trailOf(alice, world.northside.id), "access.refused");
      expect(recorded!.reason).toBe("malformed-url");
      expect(recorded!.target.id).toHaveLength(256);
      expect(recorded!.target.id).toMatch(
        new RegExp(`^GET /api/schools/${world.northside.id}/persons/x+$`),
      );
    });

    // The router rejects these itself, and only on a path matching a route with
    // a parameter, so its own answer would confirm which routes exist.
    it.each([
      ["an identifier the router will not take", `/persons/${"x".repeat(101)}`],
      ["an identifier that does not decode", "/persons/%E0%A4%A"],
      ["an unrouted path of the same shape", `/nothing/${"x".repeat(101)}`],
    ])("refuses and records %s like an absent Person", async (_case, path) => {
      const world = await arrange();
      const sam = (await server().signIn(SAM)).inSchool(world.northside.id);

      const refused = await sam.get(path);
      const absent = await sam.get(`/persons/${ABSENT_ID}`);

      expect(observable(refused)).toEqual(observable(absent));
      const alice = await server().signIn(ALICE);
      const [, recorded] = withAction(await trailOf(alice, world.northside.id), "access.refused");
      expect(recorded).toMatchObject({
        actorPersonId: world.northside.samId,
        target: { type: "request", id: `GET /api/schools/${world.northside.id}${path}` },
      });
    });

    it("records nothing for a refusal addressed to a School that does not exist", async () => {
      const world = await arrange();
      const sam = await server().signIn(SAM);

      const refused = await sam.inSchool(ABSENT_ID).get("/persons");
      const malformed = await sam.inSchool("not-a-uuid").get("/persons");

      expect(observable(malformed)).toEqual(observable(refused));
      const { rows } = await server().ownerDatabase.query<{ refusals: number }>(
        "SELECT count(*)::int AS refusals FROM app.audit_record WHERE action = 'access.refused'",
      );
      expect(rows).toEqual([{ refusals: 0 }]);
      expect(world).toBeDefined();
    });
  });

  it("records no successful routine read", async () => {
    const world = await arrange();
    const alice = await server().signIn(ALICE);
    const sam = await server().signIn(SAM);
    const before = await trailOf(alice, world.northside.id);

    for (const [client, path] of [
      [alice, "/api/schools"],
      [alice.inSchool(world.northside.id), "/persons"],
      [alice.inSchool(world.northside.id), `/persons/${world.northside.samId}`],
      [alice.inSchool(world.northside.id), "/audit-records"],
      [sam.inSchool(world.northside.id), `/persons/${world.northside.samId}`],
      [sam, "/api/session"],
    ] as const) {
      expect((await client.get(path)).status).toBe(200);
    }

    expect(await trailOf(alice, world.northside.id)).toEqual(before);
  });

  it("leaves a visible trail of a caller probing many identifiers, who sees only uniform refusals", async () => {
    const world = await arrange();
    const sam = (await server().signIn(SAM)).inSchool(world.northside.id);
    const probed = [
      ...Array.from({ length: 20 }, () => randomUUID()),
      world.northside.classmateId,
      world.northside.aliceId,
      world.westbrook.bobId,
      world.eastfield.aliceId,
    ];

    const responses = [];
    for (const id of probed) {
      responses.push(observable(await sam.get(`/persons/${id}`)));
    }

    expect(new Set(responses.map((response) => JSON.stringify(response))).size).toBe(1);
    const alice = await server().signIn(ALICE);
    const refusals = withAction(await trailOf(alice, world.northside.id), "access.refused");
    expect(refusals).toHaveLength(probed.length);
    expect(refusals.every((record) => record.actorPersonId === world.northside.samId)).toBe(true);
    expect(refusals.map((record) => record.target.id).reverse()).toEqual(probed);
  });
});
