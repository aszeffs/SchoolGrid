import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import type { UserAccount } from "../src/authentication/index.ts";
import { observable, useTestServer, type Method, type TestClient, type TestResponse } from "./support/harness.ts";

const PAT = { username: "pat", password: "the platform's own staple" };
const QUINN = { username: "quinn", password: "a second platform staple" };
const ALICE = { username: "alice", password: "correct horse battery staple" };
const BOB = { username: "bob", password: "yet another staple, longer" };
const SAM = { username: "sam", password: "a different staple entirely" };

interface Accounts {
  sam: UserAccount;
  bob: UserAccount;
}

describe("Platform Administrator", () => {
  // The route enumeration below makes more requests than the default limit allows.
  const server = useTestServer({ rateLimit: { max: 10_000, windowMs: 60_000 } });

  describe("provisioning a School", () => {
    it("creates a School whose first School Administrator can then act in it", async () => {
      const patAccount = await server().createAccount(PAT);
      await server().createPlatformAdministrator({ account: patAccount });
      const aliceAccount = await server().createAccount(ALICE);
      const pat = await server().sessionFor(patAccount);

      const provisioned = await pat.post("/api/platform/schools", {
        name: "Northside",
        timezone: "America/New_York",
        schoolAdministrator: { username: "alice", displayName: "Alice Administrator" },
      });

      expect(provisioned.status).toBe(201);
      const { school, schoolAdministrator } = provisioned.body as {
        school: { id: string; name: string; timezone: string };
        schoolAdministrator: { id: string; displayName: string };
      };
      expect(provisioned.body).toEqual({
        school: { id: expect.any(String), name: "Northside", timezone: "America/New_York" },
        schoolAdministrator: { id: expect.any(String), displayName: "Alice Administrator" },
      });

      const alice = await server().sessionFor(aliceAccount);
      expect((await alice.get("/api/schools")).body).toEqual({ schools: [{ id: school.id, name: school.name }] });
      expect((await alice.inSchool(school.id).get("/persons")).body).toEqual({
        persons: [{ ...schoolAdministrator, claimed: true }],
      });
      expect((await alice.inSchool(school.id).get("/settings")).body).toEqual(
        expect.objectContaining({ settings: { timezone: "America/New_York", timezoneFixed: false } }),
      );
    });

    it("is recorded in the School's own trail, naming the Platform Administrator, for its School Administrator to read", async () => {
      const patAccount = await server().createAccount(PAT);
      const platformAdministrator = await server().createPlatformAdministrator({ account: patAccount });
      const aliceAccount = await server().createAccount(ALICE);
      const pat = await server().sessionFor(patAccount);

      const provisioned = await pat.post("/api/platform/schools", {
        name: "Northside",
        timezone: "Asia/Manila",
        schoolAdministrator: { username: "alice", displayName: "Alice Administrator" },
      });
      const { school, schoolAdministrator } = provisioned.body as {
        school: { id: string };
        schoolAdministrator: { id: string };
      };

      const alice = (await server().sessionFor(aliceAccount)).inSchool(school.id);
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
        after: { name: "Northside", timezone: "Asia/Manila", schoolAdministratorPersonId: schoolAdministrator.id },
      });
    });

    it.each([
      ["no timezone", {}],
      ["a timezone that is no IANA identifier", { timezone: "Mars/Olympus_Mons" }],
      ["a timezone in the wrong letter case", { timezone: "asia/manila" }],
      ["an empty timezone", { timezone: "" }],
      ["a timezone that is not text", { timezone: 8 }],
    ])("requires a timezone the database knows, creating nothing given %s", async (_case, timezone) => {
      const patAccount = await server().createAccount(PAT);
      await server().createPlatformAdministrator({ account: patAccount });
      await server().createAccount(ALICE);
      const pat = await server().sessionFor(patAccount);

      const refused = await pat.post("/api/platform/schools", {
        name: "Northside",
        ...timezone,
        schoolAdministrator: { username: "alice", displayName: "Alice Administrator" },
      });

      expect(refused.status).toBe(400);
      expect(refused.body).toEqual({ status: "invalid_request" });
      const { rows } = await server().database.query("SELECT id FROM app.school");
      expect(rows).toEqual([]);
    });

    it.each([
      ["their own account", "PAT"],
      ["another Platform Administrator's account", "quinn"],
      ["an account that does not exist", "mallory"],
    ])("will not make %s a School Administrator, and creates nothing", async (_case, username) => {
      const patAccount = await server().createAccount(PAT);
      await server().createPlatformAdministrator({ account: patAccount });
      await server().createPlatformAdministrator({ account: await server().createAccount(QUINN) });
      const pat = await server().sessionFor(patAccount);

      const refused = await pat.post("/api/platform/schools", {
        name: "Northside",
        timezone: "UTC",
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
      ["an account that is no Platform Administrator", async ({ sam }: Accounts) => server().sessionFor(sam)],
      ["a School Administrator", async ({ bob }: Accounts) => server().sessionFor(bob)],
    ])("refuses %s exactly as a route that does not exist, creating nothing", async (_case, caller) => {
      const alice = await server().createAccount(ALICE);
      const sam = await server().createAccount(SAM);
      const bob = await server().createAccount(BOB);
      await server().provisionSchool({ name: "Westbrook", administrator: bob });
      const request = {
        name: "Northside",
        timezone: "UTC",
        schoolAdministrator: { username: "alice", displayName: "Alice Administrator" },
      };

      const refused = await (await caller({ sam, bob })).post("/api/platform/schools", request);
      const unrouted = await server().client.post("/api/platform/no-such-thing", request);

      expect(refused.status).not.toBe(201);
      expect(observable(refused)).toEqual(observable(unrouted));
      expect((await (await server().sessionFor(alice)).get("/api/schools")).body).toEqual({ schools: [] });
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
        pat: await server().sessionFor(patAccount),
        alice: (await server().sessionFor(alice)).inSchool(school.id),
      };
    }

    /**
     * One real record for each path parameter a School-scoped route takes,
     * arranged by Northside's School Administrator: a Student, enrolled and
     * linked to a Guardian, a membership, and a Course offered in a Term.
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
      const invited = await world.alice.post("/invitations", {
        personId: (await server().createPerson({ schoolId: world.schoolId, displayName: "Riley" })).id,
      });
      const academicYear = await world.alice.post("/academic-years", {
        name: "2026–27",
        firstDate: "2026-09-01",
        lastDate: "2027-06-30",
      });
      const academicYearId = (academicYear.body as { academicYear: { id: string } }).academicYear.id;
      const holiday = await world.alice.post(`/academic-years/${academicYearId}/exceptions`, {
        date: "2026-11-26",
        instructional: false,
      });
      const divided = await world.alice.patch(`/academic-years/${academicYearId}`, {
        terms: [{ name: "Whole year", firstDate: "2026-09-01", lastDate: "2027-06-30" }],
      });
      const termId = (divided.body as { academicYear: { terms: { id: string }[] } }).academicYear.terms[0]!.id;
      const course = await world.alice.post("/courses", { name: "Algebra I" });
      const courseId = (course.body as { course: { id: string } }).course.id;
      const offering = await world.alice.post("/class-offerings", { courseId, termId });
    const faculty = await server().createPerson({ schoolId: world.schoolId, displayName: "Frankie", role: "faculty" });
    const classOfferingId = (offering.body as { classOffering: { id: string } }).classOffering.id;
    const assigned = await world.alice.post(`/class-offerings/${classOfferingId}/teaching-assignments`, {
      personId: faculty.id,
    });
    const rostered = await world.alice.post(`/class-offerings/${classOfferingId}/roster-memberships`, {
      personIds: [student.id],
    });
      expect([
        enrolled.status,
        linked.status,
        memberships.status,
        invited.status,
        academicYear.status,
        holiday.status,
        divided.status,
        course.status,
        offering.status,
        rostered.status,
      ]).toEqual([201, 201, 200, 201, 201, 201, 200, 201, 201, 201]);
      return {
        schoolId: world.schoolId,
        personId: student.id,
        enrollmentId: (enrolled.body as { enrollment: { id: string } }).enrollment.id,
        guardianLinkId: (linked.body as { guardianLink: { id: string } }).guardianLink.id,
        membershipId: (memberships.body as { memberships: { id: string }[] }).memberships[0]!.id,
        invitationId: (invited.body as { invitation: { id: string } }).invitation.id,
        academicYearId,
        exceptionId: (holiday.body as { academicYear: { exceptions: { id: string }[] } }).academicYear.exceptions[0]!.id,
        courseId,
        classOfferingId,
        teachingAssignmentId: (assigned.body as { teachingAssignment: { id: string } }).teachingAssignment.id,
        rosterMembershipId: (rostered.body as { rosterMemberships: { id: string }[] }).rosterMemberships[0]!.id,
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
          "GET /api/build-info",
          "HEAD /api/build-info",
          "GET /api/demo",
          "HEAD /api/demo",
          "POST /api/session",
          "GET /api/session",
          "HEAD /api/session",
          "DELETE /api/session",
          "GET /api/schools",
          "HEAD /api/schools",
          "POST /api/invitations/inspect",
          "POST /api/invitations/redeem",
          "POST /api/invitations/redeem-signed-in",
          "POST /api/platform/schools",
          "POST /api/trials",
          "POST /api/trials/role",
        ].sort(),
      );
      const schoolScoped = server().routes.filter(isSchoolScoped);
      expect(schoolScoped).toEqual(
        expect.arrayContaining([
          { method: "GET", url: "/api/schools/:schoolId/persons" },
          { method: "POST", url: "/api/schools/:schoolId/persons" },
          { method: "GET", url: "/api/schools/:schoolId/audit-records" },
          { method: "POST", url: "/api/schools/:schoolId/invitations" },
          { method: "GET", url: "/api/schools/:schoolId/invitations" },
          { method: "DELETE", url: "/api/schools/:schoolId/invitations/:invitationId" },
          { method: "GET", url: "/api/schools/:schoolId/settings" },
          { method: "PATCH", url: "/api/schools/:schoolId/settings" },
          { method: "GET", url: "/api/schools/:schoolId/school-date" },
          { method: "GET", url: "/api/schools/:schoolId/academic-years" },
          { method: "POST", url: "/api/schools/:schoolId/academic-years" },
          { method: "PATCH", url: "/api/schools/:schoolId/academic-years/:academicYearId" },
          { method: "DELETE", url: "/api/schools/:schoolId/academic-years/:academicYearId" },
          { method: "POST", url: "/api/schools/:schoolId/academic-years/:academicYearId/exceptions" },
          {
            method: "DELETE",
            url: "/api/schools/:schoolId/academic-years/:academicYearId/exceptions/:exceptionId",
          },
          { method: "GET", url: "/api/schools/:schoolId/courses" },
          { method: "POST", url: "/api/schools/:schoolId/courses" },
          { method: "PATCH", url: "/api/schools/:schoolId/courses/:courseId" },
          { method: "DELETE", url: "/api/schools/:schoolId/courses/:courseId" },
          { method: "GET", url: "/api/schools/:schoolId/class-offerings" },
          { method: "POST", url: "/api/schools/:schoolId/class-offerings" },
          { method: "GET", url: "/api/schools/:schoolId/class-offerings/:classOfferingId" },
          { method: "PATCH", url: "/api/schools/:schoolId/class-offerings/:classOfferingId" },
          { method: "DELETE", url: "/api/schools/:schoolId/class-offerings/:classOfferingId" },
          { method: "POST", url: "/api/schools/:schoolId/class-offerings/:classOfferingId/teaching-assignments" },
          { method: "PATCH", url: "/api/schools/:schoolId/teaching-assignments/:teachingAssignmentId" },
          { method: "DELETE", url: "/api/schools/:schoolId/teaching-assignments/:teachingAssignmentId" },
          { method: "GET", url: "/api/schools/:schoolId/memberships/:membershipId/consequences" },
          { method: "GET", url: "/api/schools/:schoolId/account/class-offerings" },
          { method: "POST", url: "/api/schools/:schoolId/class-offerings/:classOfferingId/roster-memberships" },
          { method: "PATCH", url: "/api/schools/:schoolId/roster-memberships/:rosterMembershipId" },
          { method: "DELETE", url: "/api/schools/:schoolId/roster-memberships/:rosterMembershipId" },
          { method: "GET", url: "/api/schools/:schoolId/enrollments/:enrollmentId/consequences" },
          { method: "GET", url: "/api/schools/:schoolId/account/roster-memberships" },
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
