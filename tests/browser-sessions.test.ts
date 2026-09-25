import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import {
  cookieSentBackFor,
  observable,
  observableApartFromOwnCookie,
  setCookiesOf,
  useTestServer,
  type Method,
  type TestClient,
  type TestResponse,
} from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const PAT = { username: "pat", password: "the platform's own staple" };

/** Written out here rather than imported, so a renamed cookie fails this test. */
const SESSION_COOKIE = "__Host-session";

/** Written out too, so a changed attribute fails rather than following the source. */
const EXPIRED_SESSION_COOKIE = `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;

/** A body every route that takes one rejects, once the caller has been permitted to send it. */
const UNEXPECTED_BODY = { "not-a-field": true };

/** The cookie's name, value, and attributes, with attribute names lower-cased. */
function parseSetCookie(header: string) {
  const [pair, ...attributes] = header.split(";").map((part) => part.trim());
  const separator = pair!.indexOf("=");
  return {
    name: pair!.slice(0, separator),
    value: pair!.slice(separator + 1),
    attributes: Object.fromEntries(
      attributes.map((attribute) => {
        const [name, value = ""] = attribute.split("=");
        return [name!.toLowerCase(), value];
      }),
    ),
  };
}

/**
 * What is sent on the wire. A HEAD response carries no body there, whatever the
 * handler sent, but `inject` hands one back.
 */
function sent(method: string, response: TestResponse) {
  return method === "HEAD" ? { ...observable(response), raw: "" } : observable(response);
}

describe("Browser sessions", () => {
  // The route enumerations below make more requests than the default limit allows.
  const server = useTestServer({ rateLimit: { max: 10_000, windowMs: 60_000 } });

  describe("signing in", () => {
    it("sets a __Host- session cookie script cannot read, and returns no token", async () => {
      await server().createAccount(ALICE);

      const response = await server().client.withOrigin(server().publicOrigin).post("/api/session", ALICE);

      expect(response.status).toBe(201);
      const cookies = setCookiesOf(response);
      expect(cookies).toHaveLength(1);
      const cookie = parseSetCookie(cookies[0]!);
      expect(cookie.name).toBe(SESSION_COOKIE);
      expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(cookie.attributes).toEqual({ path: "/", secure: "", httponly: "", samesite: "Strict" });
      expect(response.body).toEqual({ expiresAt: expect.any(String) });
      expect(response.raw).not.toContain(cookie.value);
    });

    // Another site could otherwise sign a browser in as the attacker's own
    // account, so that what the victim then enters is recorded there.
    it.each([
      ["no Origin", null],
      ["a foreign Origin", "https://attacker.test"],
      ["an opaque Origin", "null"],
    ])(
      "refuses a sign-in for a cookie from %s identically to a wrong password, setting no cookie",
      async (_case, origin) => {
        await server().createAccount(ALICE);
        const client = origin === null ? server().client : server().client.withOrigin(origin);

        const wrongPassword = await client.post("/api/session", { username: "alice", password: "not the password" });
        const forged = await client.post("/api/session", ALICE);

        expect(observable(forged)).toEqual(observable(wrongPassword));
        expect(setCookiesOf(forged)).toEqual([]);
      },
    );

    it("gives a session that identifies the account when the cookie is sent back", async () => {
      await server().createAccount(ALICE);
      const alice = await server().signInWithCookie(ALICE);

      const response = await alice.get("/api/session");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ account: { id: expect.any(String), username: "alice" }, schools: [] });
    });

    it("gives a Bearer token, and no cookie, to a sign-in that asks for one", async () => {
      await server().createAccount(ALICE);

      const response = await server().client.post("/api/session", { ...ALICE, session: "bearer" });

      expect(response.status).toBe(201);
      expect(setCookiesOf(response)).toEqual([]);
      const { token } = response.body as { token: string };
      expect(response.body).toEqual({ token: expect.any(String), expiresAt: expect.any(String) });
      expect((await server().client.withBearer(token).get("/api/session")).status).toBe(200);
    });

    it.each([["an unknown kind", "jwt"], ["a non-string", true]])(
      "answers a sign-in asking for %s of session identically to a wrong password",
      async (_case, session) => {
        await server().createAccount(ALICE);

        const wrongPassword = await server().client.post("/api/session", {
          username: "alice",
          password: "not the password",
        });
        const unknownKind = await server().client.post("/api/session", { ...ALICE, session });

        expect(observable(unknownKind)).toEqual(observable(wrongPassword));
      },
    );
  });

  /**
   * Alice administers Northside, where a Student is enrolled and linked to a
   * Guardian, an unclaimed Person is invited, and an Academic Year is planned
   * with a Course offered in it, which Alice also teaches as Faculty and holds a
   * Student membership beside, so the routes only Faculty or Students reach
   * answer her too; Pat is a Platform Administrator. Each is
   * signed in twice, once with each form of session.
   */
  async function arrange() {
    await server().createPlatformAdministrator({ account: await server().createAccount(PAT) });
    const { school, schoolAdministrator } = await server().provisionSchool({
      name: "Northside",
      administrator: await server().createAccount(ALICE),
    });
    await server().grantMembership({ person: schoolAdministrator, role: "faculty" });
    await server().grantMembership({ person: schoolAdministrator, role: "student" });
    const aliceBearer = (await server().signIn(ALICE)).inSchool(school.id);
    const student = await server().createPerson({ schoolId: school.id, displayName: "Sam", role: "student" });
    const guardian = await server().createPerson({ schoolId: school.id, displayName: "Gina", role: "guardian" });
    const enrolled = await aliceBearer.post("/enrollments", { studentPersonId: student.id });
    const linked = await aliceBearer.post("/guardian-links", {
      guardianPersonId: guardian.id,
      studentPersonId: student.id,
      accessProfile: { attendanceRead: true, resultsRead: true },
    });
    const memberships = await aliceBearer.get("/memberships");
    const invited = await aliceBearer.post("/invitations", {
      personId: (await server().createPerson({ schoolId: school.id, displayName: "Riley" })).id,
    });
    const academicYear = await aliceBearer.post("/academic-years", {
      name: "2026–27",
      firstDate: "2026-09-01",
      lastDate: "2027-06-30",
    });
    const academicYearId = (academicYear.body as { academicYear: { id: string } }).academicYear.id;
    const holiday = await aliceBearer.post(`/academic-years/${academicYearId}/exceptions`, {
      date: "2026-11-26",
      instructional: false,
    });
    const divided = await aliceBearer.patch(`/academic-years/${academicYearId}`, {
      terms: [{ name: "Whole year", firstDate: "2026-09-01", lastDate: "2027-06-30" }],
    });
    const termId = (divided.body as { academicYear: { terms: { id: string }[] } }).academicYear.terms[0]!.id;
    const course = await aliceBearer.post("/courses", { name: "Algebra I" });
    const courseId = (course.body as { course: { id: string } }).course.id;
    const offering = await aliceBearer.post("/class-offerings", { courseId, termId });
    const classOfferingId = (offering.body as { classOffering: { id: string } }).classOffering.id;
    const assigned = await aliceBearer.post(`/class-offerings/${classOfferingId}/teaching-assignments`, {
      personId: schoolAdministrator.id,
    });
    const rostered = await aliceBearer.post(`/class-offerings/${classOfferingId}/roster-memberships`, {
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
      assigned.status,
      rostered.status,
    ]).toEqual([201, 201, 200, 201, 201, 201, 200, 201, 201, 201, 201]);

    const identifiers: Record<string, string> = {
      schoolId: school.id,
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
    };
    return {
      school,
      student,
      pathOf: (method: string, url: string) =>
        url.replace(/:(\w+)/g, (_parameter, name: string) => {
          const identifier = identifiers[name];
          if (identifier === undefined) {
            throw new Error(`${method} ${url} takes :${name}, which this suite has no record for.`);
          }
          return identifier;
        }),
      alice: {
        bearer: await server().signIn(ALICE),
        cookie: (await server().signInWithCookie(ALICE)).withOrigin(server().publicOrigin),
      },
      pat: {
        bearer: await server().signIn(PAT),
        cookie: (await server().signInWithCookie(PAT)).withOrigin(server().publicOrigin),
      },
    };
  }

  /**
   * Every route the server registered, requested with each form of session by
   * a School Administrator and a Platform Administrator. Whatever a route
   * answers one form, it answers the other, and it answers one of them
   * differently from a caller with no session at all.
   */
  it("is accepted by every School-scoped and platform endpoint exactly as a Bearer session is", async () => {
    const world = await arrange();
    // Nothing here authenticates a caller: health, build info and whether
    // trials are offered answer anyone, sign-in makes a session rather than reading one,
    // and sign-out ends the session it reads.
    // Redeeming as the signed-in account reads a session only once the secret
    // names a pending Invitation, which this body never does: both forms are
    // asserted there instead, in tests/invitations.test.ts. Starting a trial
    // makes a session rather than reading one, and changing role refuses every
    // caller here, where trials are off: its session is asserted in
    // tests/trial-schools.test.ts.
    const notAuthenticated = [
      "GET /api/health",
      "HEAD /api/health",
      "GET /api/build-info",
      "HEAD /api/build-info",
      "POST /api/session",
      "DELETE /api/session",
      "POST /api/invitations/inspect",
      "POST /api/invitations/redeem",
      "POST /api/invitations/redeem-signed-in",
      "GET /api/trials",
      "HEAD /api/trials",
      "POST /api/trials",
      "POST /api/trials/role",
    ];
    const routes = server().routes.filter(({ method, url }) => !notAuthenticated.includes(`${method} ${url}`));
    expect(routes.map(({ method, url }) => `${method} ${url}`)).toEqual(
      expect.arrayContaining(["GET /api/session", "POST /api/platform/schools", "GET /api/schools/:schoolId/persons"]),
    );

    const differing: string[] = [];
    for (const { method, url } of routes) {
      const path = world.pathOf(method, url);
      const body = method === "GET" || method === "HEAD" ? undefined : UNEXPECTED_BODY;
      const anonymous = await server().client.request(method as Method, path, body);

      let accepted = false;
      for (const caller of [world.alice, world.pat]) {
        const bearer = await caller.bearer.request(method as Method, path, body);
        const cookie = await caller.cookie.request(method as Method, path, body);
        if (!isDeepStrictEqual(sent(method, bearer), sent(method, cookie))) {
          differing.push(`${method} ${url} answered Bearer ${bearer.status} but cookie ${cookie.status}`);
        }
        accepted ||= !isDeepStrictEqual(sent(method, bearer), sent(method, anonymous));
      }
      if (!accepted) {
        differing.push(`${method} ${url} answered no session-holder differently from a caller without one`);
      }
    }

    expect(differing).toEqual([]);
  });

  describe("a change authenticated by the cookie", () => {
    it.each([
      ["no Origin", null],
      ["a foreign Origin", "https://attacker.test"],
      ["an opaque Origin", "null"],
      ["the public origin over another scheme", "http://schoolgrid.test"],
      ["a lookalike of the public origin", "https://schoolgrid.test.attacker.test"],
    ])("from %s is refused exactly as a caller with no session, on every route", async (_case, origin) => {
      const world = await arrange();
      const signedIn = await server().signInWithCookie(ALICE);
      const alice = origin === null ? signedIn : signedIn.withOrigin(origin);
      const changes = server().routes.filter(
        ({ method, url }) => ["POST", "PATCH", "DELETE"].includes(method) && url !== "/api/session",
      );
      expect(changes.length).toBeGreaterThan(0);

      const answered: string[] = [];
      // Sign-out last, so a sign-out that went through would not hide the others.
      for (const { method, url } of [...changes, { method: "DELETE", url: "/api/session" }]) {
        const path = world.pathOf(method, url);
        const refused = await alice.request(method as Method, path, UNEXPECTED_BODY);
        const anonymous = await server().client.request(method as Method, path, UNEXPECTED_BODY);
        if (!isDeepStrictEqual(observable(refused), observable(anonymous))) {
          answered.push(`${method} ${url} answered ${refused.status}`);
        }
      }

      expect(answered).toEqual([]);
      expect((await alice.get("/api/session")).status).toBe(200);
    });

    it("changes nothing when refused, and is recorded in the School's trail with its true reason", async () => {
      const world = await arrange();
      const student = await server().createPerson({
        schoolId: world.school.id,
        displayName: "Tess",
        role: "student",
      });
      const alice = (await server().signInWithCookie(ALICE)).withOrigin("https://attacker.test");

      const refused = await alice.inSchool(world.school.id).post("/enrollments", { studentPersonId: student.id });

      expect(refused.body).toEqual({ status: "refused" });
      const bearer = world.alice.bearer.inSchool(world.school.id);
      const enrollments = (await bearer.get("/enrollments")).body as { enrollments: { studentPersonId: string }[] };
      expect(enrollments.enrollments.map(({ studentPersonId }) => studentPersonId)).not.toContain(student.id);
      const trail = (await bearer.get("/audit-records")).body as { auditRecords: unknown[] };
      expect(trail.auditRecords).toContainEqual(
        expect.objectContaining({
          action: "access.refused",
          reason: "cross-origin",
          target: { type: "request", id: `POST /api/schools/${world.school.id}/enrollments` },
        }),
      );
    });

    it("goes through from the public origin", async () => {
      const world = await arrange();
      const student = await server().createPerson({ schoolId: world.school.id, displayName: "Tess", role: "student" });

      const enrolled = await world.alice.cookie
        .inSchool(world.school.id)
        .post("/enrollments", { studentPersonId: student.id });

      expect(enrolled.status).toBe(201);
    });

    it("is not asked for an Origin when the session is a Bearer token", async () => {
      const world = await arrange();
      const student = await server().createPerson({ schoolId: world.school.id, displayName: "Tess", role: "student" });

      const enrolled = await world.alice.bearer
        .withOrigin("https://attacker.test")
        .inSchool(world.school.id)
        .post("/enrollments", { studentPersonId: student.id });

      expect(enrolled.status).toBe(201);
    });

    it("needs no Origin to read", async () => {
      await server().createAccount(ALICE);
      const alice = await server().signInWithCookie(ALICE);

      expect((await alice.get("/api/session")).status).toBe(200);
    });
  });

  describe("presenting both a cookie and a Bearer token", () => {
    it("is refused exactly as a caller with no session, even when both are live", async () => {
      await server().createAccount(ALICE);
      const cookie = (await server().signInWithCookie(ALICE)).withOrigin(server().publicOrigin);
      const bearerResponse = await server().client.post("/api/session", { ...ALICE, session: "bearer" });
      const both = cookie.withBearer((bearerResponse.body as { token: string }).token);

      const identify = await both.get("/api/session");
      const end = await both.delete("/api/session");

      expect(observable(identify)).toEqual(observable(await server().client.get("/api/session")));
      // Sign-out expires the cookie this caller itself sent, so that one header
      // differs from a caller who sent none; the refusal is otherwise identical.
      expect(observableApartFromOwnCookie(end)).toEqual(
        observableApartFromOwnCookie(await server().client.delete("/api/session")),
      );
      expect(setCookiesOf(end)).toEqual([EXPIRED_SESSION_COOKIE]);
      expect((await cookie.get("/api/session")).status).toBe(200);
    });

    it("is recorded in the School's trail with its true reason", async () => {
      const world = await arrange();
      const cookie = (await server().signInWithCookie(ALICE)).withOrigin(server().publicOrigin);
      const bearerResponse = await server().client.post("/api/session", { ...ALICE, session: "bearer" });
      const both = cookie.withBearer((bearerResponse.body as { token: string }).token);

      await both.inSchool(world.school.id).get("/persons");

      const trail = (await world.alice.bearer.inSchool(world.school.id).get("/audit-records")).body as {
        auditRecords: unknown[];
      };
      expect(trail.auditRecords).toContainEqual(
        expect.objectContaining({ action: "access.refused", reason: "ambiguous-session" }),
      );
    });

    it("does not count a cookie that is not the session", async () => {
      await server().createAccount(ALICE);
      const alice = (await server().signIn(ALICE)).withCookie("theme=dark");

      expect((await alice.get("/api/session")).status).toBe(200);
    });
  });

  describe("a cookie that is not a live session is treated exactly as no session", () => {
    /** Signs Alice in as a browser does, returning the `Cookie` header it would send back. */
    async function signedInCookie(): Promise<string> {
      await server().createAccount(ALICE);
      const response = await server().client.withOrigin(server().publicOrigin).post("/api/session", ALICE);
      return cookieSentBackFor(response);
    }

    it.each([
      ["an unrelated cookie", async () => "theme=dark"],
      ["an unrecognised token", async () => `${SESSION_COOKIE}=dGhpcyBpcyBpbnZlbnRlZA`],
      ["a malformed token", async () => `${SESSION_COOKIE}=not a token!`],
      ["an empty value", async () => `${SESSION_COOKIE}=`],
      [
        "a live token under a name without the __Host- prefix",
        async () => (await signedInCookie()).replace("__Host-", ""),
      ],
      [
        "two live session cookies at once",
        async () => {
          const first = await signedInCookie();
          const second = cookieSentBackFor(
            await server().client.withOrigin(server().publicOrigin).post("/api/session", ALICE),
          );
          return `${first}; ${second}`;
        },
      ],
      [
        "an expired session",
        async () => {
          const cookie = await signedInCookie();
          // Arranging the passage of time: the session's lifetime has run out.
          await server().database.query("UPDATE app.user_session SET expires_at = now() - interval '1 second'");
          return cookie;
        },
      ],
      [
        "a signed-out session",
        async () => {
          const cookie = await signedInCookie();
          const ended = await server().client.withCookie(cookie).withOrigin(server().publicOrigin).delete("/api/session");
          expect(ended.status).toBe(204);
          return cookie;
        },
      ],
    ])("for %s", async (_case, arrange) => {
      const bob = await server().createAccount({ username: "bob", password: "yet another staple, longer" });
      const { school } = await server().provisionSchool({ name: "Northside", administrator: bob });
      const cookie = await arrange();
      const caller = server().client.withCookie(cookie).withOrigin(server().publicOrigin);
      const anonymous = server().client.withOrigin(server().publicOrigin);
      // Sign-out expires a session cookie the caller carried, whether or not a
      // live Session was behind it (#89). A cookie under any other name is not
      // one, so it leaves the response untouched.
      const carriesSessionCookie = cookie.includes(`${SESSION_COOKIE}=`);

      for (const [method, path] of [
        ["GET", "/api/session"],
        ["DELETE", "/api/session"],
        ["GET", "/api/schools"],
        ["GET", `/api/schools/${school.id}/persons`],
      ] as const) {
        const presented = await caller.request(method, path);
        const without = await anonymous.request(method, path);
        expect(without.status, `${method} ${path}`).toBe(404);
        expect(observableApartFromOwnCookie(presented), `${method} ${path}`).toEqual(
          observableApartFromOwnCookie(without),
        );
        expect(setCookiesOf(presented), `${method} ${path}`).toEqual(
          method === "DELETE" && carriesSessionCookie ? [EXPIRED_SESSION_COOKIE] : [],
        );
        expect(setCookiesOf(without), `${method} ${path}`).toEqual([]);
      }
    });
  });

  describe("signing out", () => {
    async function signedIn(): Promise<{ alice: TestClient; response: TestResponse }> {
      await server().createAccount(ALICE);
      const alice = (await server().signInWithCookie(ALICE)).withOrigin(server().publicOrigin);
      return { alice, response: await alice.delete("/api/session") };
    }

    /** Signs an existing Alice in as a browser does, returning the `Cookie` header it sends back. */
    async function signedInCookie(): Promise<string> {
      return cookieSentBackFor(await server().client.withOrigin(server().publicOrigin).post("/api/session", ALICE));
    }

    it("ends the session and expires the cookie", async () => {
      const { response } = await signedIn();

      expect(response.status).toBe(204);
      const cookies = setCookiesOf(response);
      expect(cookies).toHaveLength(1);
      const cookie = parseSetCookie(cookies[0]!);
      expect(cookie.name).toBe(SESSION_COOKIE);
      expect(cookie.value).toBe("");
      expect(cookie.attributes).toEqual({
        path: "/",
        secure: "",
        httponly: "",
        samesite: "Strict",
        "max-age": "0",
      });
    });

    it("leaves the old cookie refused when it is replayed", async () => {
      const { alice } = await signedIn();
      const anonymous = server().client.withOrigin(server().publicOrigin);

      expect(observable(await alice.get("/api/session"))).toEqual(observable(await anonymous.get("/api/session")));
      const replayed = await alice.delete("/api/session");
      expect(observableApartFromOwnCookie(replayed)).toEqual(
        observableApartFromOwnCookie(await anonymous.delete("/api/session")),
      );
      // The Session is long gone, but the cookie is still the caller's own to clear.
      expect(setCookiesOf(replayed)).toEqual([EXPIRED_SESSION_COOKIE]);
    });

    it("sets no cookie when a Bearer session signs out", async () => {
      await server().createAccount(ALICE);
      const alice = await server().signIn(ALICE);

      const response = await alice.delete("/api/session");

      expect(response.status).toBe(204);
      expect(setCookiesOf(response)).toEqual([]);
    });

    it("expires the cookie with the name, path and attributes sign-in set it with", async () => {
      await server().createAccount(ALICE);
      const signedIn = await server().client.withOrigin(server().publicOrigin).post("/api/session", ALICE);
      const set = parseSetCookie(setCookiesOf(signedIn)[0]!);

      const alice = server().client.withCookie(cookieSentBackFor(signedIn)).withOrigin(server().publicOrigin);
      const expired = parseSetCookie(setCookiesOf(await alice.delete("/api/session"))[0]!);

      // Any difference in name, path or attributes and the browser keeps the
      // old cookie alongside the new one instead of replacing it.
      expect(expired.name).toBe(set.name);
      expect(expired.attributes).toEqual({ ...set.attributes, "max-age": "0" });
      expect(expired.value).toBe("");
    });

    describe("a cookie with no live Session behind it", () => {
      it.each([
        ["a well-formed token nothing is behind", async () => `${SESSION_COOKIE}=dGhpcyBpcyBpbnZlbnRlZA`],
        ["a value that could never be a token", async () => `${SESSION_COOKIE}=not a token!`],
        [
          "two session cookies at once",
          async () => {
            const first = await signedInCookie();
            const second = await signedInCookie();
            return `${first}; ${second}`;
          },
        ],
      ])("is refused, and expires the cookie the request carried, for %s", async (_case, arrange) => {
        await server().createAccount(ALICE);
        const caller = server().client.withCookie(await arrange()).withOrigin(server().publicOrigin);

        const response = await caller.delete("/api/session");

        expect(response.status).toBe(404);
        expect(response.body).toEqual({ status: "refused" });
        expect(setCookiesOf(response)).toEqual([EXPIRED_SESSION_COOKIE]);
      });

      it("is refused, and expires the cookie, for a cookie alongside a Bearer token", async () => {
        await server().createAccount(ALICE);
        const cookie = (await server().signInWithCookie(ALICE)).withOrigin(server().publicOrigin);
        const bearer = await server().client.post("/api/session", { ...ALICE, session: "bearer" });
        const both = cookie.withBearer((bearer.body as { token: string }).token);

        const response = await both.delete("/api/session");

        expect(response.status).toBe(404);
        expect(setCookiesOf(response)).toEqual([EXPIRED_SESSION_COOKIE]);
      });

      // Sign-out names no School, so its refusal has no trail to be recorded
      // in and its reason reaches the log alone (ADR-0002): `ambiguous-session`
      // itself is pinned where it is observable, on the School-scoped route
      // above. What is observable here is that expiring the cookie is decided
      // without disturbing the check order — an ambiguous request is still
      // judged ambiguous before the Origin check it never reaches, so a
      // cross-origin one is refused with no cookie like any other.
      it("expires no cookie when the ambiguous sign-out came from another origin", async () => {
        await server().createAccount(ALICE);
        const cookie = await signedInCookie();
        const bearer = await server().client.post("/api/session", { ...ALICE, session: "bearer" });
        const both = server()
          .client.withCookie(cookie)
          .withBearer((bearer.body as { token: string }).token)
          .withOrigin("https://attacker.test");

        const response = await both.delete("/api/session");

        expect(response.status).toBe(404);
        expect(setCookiesOf(response)).toEqual([]);
      });
    });

    it("expires no cookie for a sign-out that carried none", async () => {
      const anonymous = server().client.withOrigin(server().publicOrigin);

      const response = await anonymous.delete("/api/session");

      expect(response.status).toBe(404);
      expect(setCookiesOf(response)).toEqual([]);
    });

    it.each([
      ["another origin", "https://attacker.test"],
      ["no origin at all", undefined],
    ])("expires no cookie for a sign-out from %s", async (_case, origin) => {
      await server().createAccount(ALICE);
      const cookie = await signedInCookie();
      const caller =
        origin === undefined
          ? server().client.withCookie(cookie)
          : server().client.withCookie(cookie).withOrigin(origin);

      const response = await caller.delete("/api/session");

      // Letting another origin expire the cookie would give a cross-site
      // request an effect on the Session, which is exactly what ADR-0004's
      // Origin check exists to prevent. SameSite=Strict is the first defence
      // there, not a reason to drop this one.
      expect(response.status).toBe(404);
      expect(setCookiesOf(response)).toEqual([]);
      // The Session it named is untouched, and still signs out from its own origin.
      const ended = await server().client.withCookie(cookie).withOrigin(server().publicOrigin).delete("/api/session");
      expect(ended.status).toBe(204);
    });
  });
});
