import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { observable, useTestServer, type Method, type TestClient, type TestResponse } from "./support/harness.ts";

const PAT = { username: "pat", password: "the platform's own staple" };
const QUINN = { username: "quinn", password: "a second platform staple" };
const ALICE = { username: "alice", password: "correct horse battery staple" };
const BOB = { username: "bob", password: "yet another staple, longer" };
const SAM = { username: "sam", password: "a different staple entirely" };

describe("Platform Administrator", () => {
  const server = useTestServer();

  describe("provisioning a School", () => {
    it("creates a School whose first School Administrator can then act in it", async () => {
      await server().createPlatformAdministrator({ account: await server().createAccount(PAT) });
      await server().createAccount(ALICE);
      const pat = await server().signIn(PAT);

      const provisioned = await pat.post("/api/platform/schools", {
        name: "Northside",
        schoolAdministrator: { username: "alice", displayName: "Alice Administrator" },
      });

      expect(provisioned.status).toBe(201);
      const { school, schoolAdministrator } = provisioned.body as {
        school: { id: string; name: string };
        schoolAdministrator: { id: string; displayName: string };
      };
      expect(provisioned.body).toEqual({
        school: { id: expect.any(String), name: "Northside" },
        schoolAdministrator: { id: expect.any(String), displayName: "Alice Administrator" },
      });

      const alice = await server().signIn(ALICE);
      expect((await alice.get("/api/schools")).body).toEqual({ schools: [school] });
      expect((await alice.inSchool(school.id).get("/persons")).body).toEqual({
        persons: [{ ...schoolAdministrator, claimed: true }],
      });
    });

    it("is recorded in the School's own trail, naming the Platform Administrator, for its School Administrator to read", async () => {
      const platformAdministrator = await server().createPlatformAdministrator({
        account: await server().createAccount(PAT),
      });
      await server().createAccount(ALICE);
      const pat = await server().signIn(PAT);

      const provisioned = await pat.post("/api/platform/schools", {
        name: "Northside",
        schoolAdministrator: { username: "alice", displayName: "Alice Administrator" },
      });
      const { school, schoolAdministrator } = provisioned.body as {
        school: { id: string };
        schoolAdministrator: { id: string };
      };

      const alice = (await server().signIn(ALICE)).inSchool(school.id);
      const trail = await alice.get("/audit-records");

      expect(trail.status).toBe(200);
      expect((trail.body as { auditRecords: unknown[] }).auditRecords.at(-1)).toEqual({
        id: expect.any(String),
        occurredAt: expect.any(String),
        actorPersonId: null,
        actorPlatformAdministratorId: platformAdministrator.id,
        action: "school.provisioned",
        target: { type: "school", id: school.id },
        reason: null,
        before: null,
        after: { name: "Northside", schoolAdministratorPersonId: schoolAdministrator.id },
      });
    });

    it.each([
      ["their own account", "PAT"],
      ["another Platform Administrator's account", "quinn"],
      ["an account that does not exist", "mallory"],
    ])("will not make %s a School Administrator, and creates nothing", async (_case, username) => {
      await server().createPlatformAdministrator({ account: await server().createAccount(PAT) });
      await server().createPlatformAdministrator({ account: await server().createAccount(QUINN) });
      const pat = await server().signIn(PAT);

      const refused = await pat.post("/api/platform/schools", {
        name: "Northside",
        schoolAdministrator: { username, displayName: "Northside Administrator" },
      });

      expect(refused.status).toBe(400);
      expect(refused.body).toEqual({ status: "invalid_request" });
      // No route lists the platform's Schools, and a School made here would be
      // reachable by no one who could say so, so the database is asked instead.
      const { rows } = await server().database.query("SELECT id FROM app.school");
      expect(rows).toEqual([]);
    });

    it.each([
      ["no session", async () => server().client],
      ["an account that is no Platform Administrator", async () => server().signIn(SAM)],
      ["a School Administrator", async () => server().signIn(BOB)],
    ])("refuses %s exactly as a route that does not exist, creating nothing", async (_case, caller) => {
      await server().createAccount(ALICE);
      await server().createAccount(SAM);
      await server().provisionSchool({ name: "Westbrook", administrator: await server().createAccount(BOB) });
      const request = {
        name: "Northside",
        schoolAdministrator: { username: "alice", displayName: "Alice Administrator" },
      };

      const refused = await (await caller()).post("/api/platform/schools", request);
      const unrouted = await server().client.post("/api/platform/no-such-thing", request);

      expect(refused.status).not.toBe(201);
      expect(observable(refused)).toEqual(observable(unrouted));
      expect((await (await server().signIn(ALICE)).get("/api/schools")).body).toEqual({ schools: [] });
    });
  });

  describe("inside a School", () => {
    /**
     * Pat is a Platform Administrator whose account a Northside Person, holding
     * a School Administrator membership, also points at. No request can arrange
     * that; it stands for a Person made by any other means.
     */
    async function arrange() {
      const patAccount = await server().createAccount(PAT);
      const platformAdministrator = await server().createPlatformAdministrator({ account: patAccount });
      const alice = await server().createAccount(ALICE);
      const { school } = await server().provisionSchool({ name: "Northside", administrator: alice });
      const patPerson = await server().createPerson({
        schoolId: school.id,
        displayName: "Pat",
        account: patAccount,
        role: "school_administrator",
      });
      return {
        schoolId: school.id,
        platformAdministrator,
        patPerson,
        pat: await server().signIn(PAT),
        alice: (await server().signIn(ALICE)).inSchool(school.id),
      };
    }

    /**
     * One real record for each path parameter a School-scoped route takes,
     * arranged by Northside's School Administrator: a Student, enrolled and
     * linked to a Guardian, and a membership.
     */
    async function arrangeRecordsFor(world: { schoolId: string; alice: TestClient }) {
      const student = await server().createPerson({ schoolId: world.schoolId, displayName: "Sam", role: "student" });
      const guardian = await server().createPerson({ schoolId: world.schoolId, displayName: "Gina", role: "guardian" });
      const enrolled = await world.alice.post("/enrollments", { studentPersonId: student.id });
      const linked = await world.alice.post("/guardian-links", {
        guardianPersonId: guardian.id,
        studentPersonId: student.id,
        accessProfile: { attendanceRead: true, resultsRead: true },
      });
      const memberships = await world.alice.get("/memberships");
      expect([enrolled.status, linked.status, memberships.status]).toEqual([201, 201, 200]);
      return {
        schoolId: world.schoolId,
        personId: student.id,
        enrollmentId: (enrolled.body as { enrollment: { id: string } }).enrollment.id,
        guardianLinkId: (linked.body as { guardianLink: { id: string } }).guardianLink.id,
        membershipId: (memberships.body as { memberships: { id: string }[] }).memberships[0]!.id,
      } as Record<string, string>;
    }

    it("reaches nothing, even through a Person their account resolves to, and lists no School", async () => {
      const world = await arrange();

      const asPlatformAdministrator = await world.pat.inSchool(world.schoolId).get("/persons");
      const unauthenticated = await server().client.inSchool(world.schoolId).get("/persons");

      expect(observable(asPlatformAdministrator)).toEqual(observable(unauthenticated));
      expect((await world.pat.get("/api/schools")).body).toEqual({ schools: [] });
    });

    it("cannot read any School's Audit records", async () => {
      const world = await arrange();
      const westbrook = await server().provisionSchool({
        name: "Westbrook",
        administrator: await server().createAccount(BOB),
      });

      for (const schoolId of [world.schoolId, westbrook.school.id]) {
        const asPlatformAdministrator = await world.pat.inSchool(schoolId).get("/audit-records");
        const unauthenticated = await server().client.inSchool(schoolId).get("/audit-records");
        expect(observable(asPlatformAdministrator)).toEqual(observable(unauthenticated));
      }
    });

    /**
     * Every route under `/api/schools/:schoolId` the server registered, however it
     * was registered, is requested as Pat against records that exist. Pat's
     * account resolves to a Northside School Administrator, so a route that
     * forgot the Platform Administrator would answer them; this suite is where
     * that shows.
     *
     * A route anywhere else must be one of those named here as reaching no
     * School's records. A new one fails until someone decides which it is: a
     * School's records are addressed under `/api/schools/:schoolId`, or nowhere.
     */
    it("is refused by every School-scoped endpoint, exactly as a route that does not exist", async () => {
      const world = await arrange();
      const identifiers = await arrangeRecordsFor(world);
      const isSchoolScoped = ({ url }: { url: string }) => url.startsWith("/api/schools/:schoolId/");
      const outsideASchool = server()
        .routes.filter((route) => !isSchoolScoped(route))
        .map(({ method, url }) => `${method} ${url}`);
      expect(outsideASchool.sort()).toEqual(
        [
          "GET /api/health",
          "HEAD /api/health",
          "POST /api/session",
          "GET /api/session",
          "HEAD /api/session",
          "DELETE /api/session",
          "GET /api/schools",
          "HEAD /api/schools",
          "POST /api/platform/schools",
        ].sort(),
      );
      const schoolScoped = server().routes.filter(isSchoolScoped);
      expect(schoolScoped).toEqual(
        expect.arrayContaining([
          { method: "GET", url: "/api/schools/:schoolId/persons" },
          { method: "POST", url: "/api/schools/:schoolId/persons" },
          { method: "GET", url: "/api/schools/:schoolId/audit-records" },
        ]),
      );

      const answered: string[] = [];
      for (const { method, url } of schoolScoped) {
        const path = url.replace(/:(\w+)/g, (_parameter, name: string) => {
          const identifier = identifiers[name];
          if (identifier === undefined) {
            throw new Error(
              `${method} ${url} takes :${name}, which this suite has no record for. ` +
                `Arrange one in arrangeRecordsFor, so the route is tried against a record that exists.`,
            );
          }
          return identifier;
        });
        const body = method === "GET" || method === "HEAD" ? undefined : {};
        const unrouted = `/api/schools/${world.schoolId}/no-such-route`;

        const asPlatformAdministrator = await world.pat.request(method as Method, path, body);
        const unauthenticated = await server().client.request(method as Method, path, body);
        const nonexistent = await server().client.request(method as Method, unrouted, body);

        // A HEAD response carries no body on the wire, whatever the handler sent:
        // Node's server drops it. `inject` does not, and hands back the body an
        // unrouted HEAD was answered with, so for HEAD only what is sent is compared.
        const sent = (response: TestResponse) =>
          method === "HEAD" ? { ...observable(response), raw: "" } : observable(response);
        if (
          !isDeepStrictEqual(sent(asPlatformAdministrator), sent(nonexistent)) ||
          !isDeepStrictEqual(sent(unauthenticated), sent(nonexistent))
        ) {
          answered.push(`${method} ${url} answered ${asPlatformAdministrator.status}`);
        }
      }
      expect(answered).toEqual([]);
    });

    it("is recorded in the School's trail as the Platform Administrator who was refused", async () => {
      const world = await arrange();

      await world.pat.inSchool(world.schoolId).get(`/persons/${world.patPerson.id}`);

      const trail = (await world.alice.get("/audit-records")).body as { auditRecords: unknown[] };
      expect(trail.auditRecords).toContainEqual(
        expect.objectContaining({
          actorPersonId: null,
          actorPlatformAdministratorId: world.platformAdministrator.id,
          action: "access.refused",
          reason: "platform-administrator",
          target: { type: "request", id: `GET /api/schools/${world.schoolId}/persons/${world.patPerson.id}` },
          after: null,
        }),
      );
    });
  });
});
