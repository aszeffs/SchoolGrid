import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  cookieSentBackFor,
  observable,
  setCookiesOf,
  TEST_IDENTITY_KEY,
  useTestServer,
  type TestClient,
} from "./support/harness.ts";

const ROLES = ["school_administrator", "faculty", "student", "guardian"] as const;

const REFUSED = { status: "refused" };

const INVENTED_PERSONS = [
  "Alex Lindqvist",
  "Avery Castellano",
  "Casey Moreau",
  "Jamie Lindqvist",
  "Jordan Okafor",
  "Morgan Reyes",
  "Priya Okonkwo",
  "Quinn Adebayo",
  "Riley Fernsby",
  "Sam Achterberg",
  "Taylor Nakamura",
];

const MINUTE = 60_000;

interface ReachedSchool {
  schoolId: string;
  name: string;
  personId: string;
  displayName: string;
  roles: string[];
  classOfferingsTaught: number;
  trialExpiresAt?: string;
  viewingAs?: string;
}

async function sessionOf(client: TestClient) {
  return (await client.get("/api/session")).body as { account: { username: string }; schools: ReachedSchool[] };
}

/** Changes role as the switcher does, returning a client sending back the new Session. */
async function switchRole(client: TestClient, role: string): Promise<TestClient> {
  const response = await client.post("/api/trials/role", { role });
  expect(response.status).toBe(201);
  return client.withCookie(cookieSentBackFor(response));
}

/** Today in a timezone, as `YYYY-MM-DD`. */
function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
}

interface ServedRequest {
  id: string;
  kind: "attendance" | "term_result";
  state: string;
  student: { id: string; displayName: string };
  classOffering: { id: string };
  date: string;
  before: string | null;
  after: string;
  requestedBy: { displayName: string };
  selfApproved: boolean;
}

interface ServedSession {
  opened: { by: { displayName: string } } | null;
  students: { unmarkableBecause: string | null }[];
}

/** The Class Offerings of the Term running on the School's today, as a School Administrator reads them. */
async function currentOfferingsOf(school: TestClient): Promise<{ id: string }[]> {
  const { classOfferings } = (await school.get("/class-offerings")).body as {
    classOfferings: { id: string; term: { firstDate: string; lastDate: string } }[];
  };
  const { today } = await attendanceOf(school, classOfferings[0]!.id);
  return classOfferings.filter(({ term }) => term.firstDate <= today && today <= term.lastDate);
}

/** A Class Offering's Attendance: the School's today, the dates it is shown on, and every Student's marks and totals. */
async function attendanceOf(school: TestClient, classOfferingId: string) {
  const response = await school.get(`/class-offerings/${classOfferingId}/attendance`);
  expect(response.status).toBe(200);
  return (response.body as {
    classOfferingAttendance: {
      today: string;
      dates: { date: string }[];
      students: { attendance: { date: string; recordedBy: { displayName: string } }[]; totals: Record<string, number> }[];
    };
  }).classOfferingAttendance;
}

interface ServedTermResult {
  value: string | null;
  recordedBy: { displayName: string };
  publishedAt: string | null;
}

/** A Class Offering's results as its reader is served them: each Student's, and what a Publication would wait on. */
async function termResultsOf(school: TestClient, classOfferingId: string) {
  const response = await school.get(`/class-offerings/${classOfferingId}/term-results`);
  expect(response.status).toBe(200);
  return (response.body as {
    classOfferingResults: {
      publication: { missingValue: { displayName: string }[] };
      students: { person: { displayName: string }; termResult: ServedTermResult | null }[];
    };
  }).classOfferingResults;
}

/** The session on a date, or on the School's today given none. */
async function attendanceSessionOf(school: TestClient, classOfferingId: string, date?: string): Promise<ServedSession> {
  const response = await school.get(
    `/class-offerings/${classOfferingId}/attendance-session${date === undefined ? "" : `?date=${date}`}`,
  );
  expect(response.status).toBe(200);
  return (response.body as { attendanceSession: ServedSession }).attendanceSession;
}

describe("Trial Schools", () => {
  describe("with trials on", () => {
    const server = useTestServer({ trials: { enabled: true } });

    it("says trials are offered, and through which providers, to anyone, with no Session", async () => {
      const response = await server().client.get("/api/trials");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ enabled: true, providers: ["github", "google"] });
    });

    it("starts a private School of invented data, around the visitor's today, as its School Administrator", async () => {
      const before = Date.now();
      const { client, schoolId, expiresAt } = await server().startTrial({ timezone: "Pacific/Kiritimati" });

      // Two hours from now.
      expect(Date.parse(expiresAt) - before).toBeGreaterThan(120 * MINUTE - MINUTE);
      expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(120 * MINUTE);

      const session = await sessionOf(client);
      expect(session.schools).toEqual([
        {
          schoolId,
          name: "Riverbend School",
          personId: expect.any(String),
          displayName: "Morgan Reyes",
          roles: ["school_administrator"],
          classOfferingsTaught: 0,
          trialExpiresAt: expiresAt,
          viewingAs: "school_administrator",
        },
      ]);

      const school = client.inSchool(schoolId);
      const settings = (await school.get("/settings")).body as { settings: { timezone: string; attendanceWindow: number } };
      expect(settings.settings).toEqual(expect.objectContaining({ timezone: "Pacific/Kiritimati", attendanceWindow: 7 }));

      const persons = (await school.get("/persons")).body as { persons: { displayName: string }[] };
      expect(persons.persons.map((person) => person.displayName)).toEqual(INVENTED_PERSONS);

      const { academicYears } = (await school.get("/academic-years")).body as {
        academicYears: {
          firstDate: string;
          lastDate: string;
          terms: { firstDate: string; lastDate: string }[];
          exceptions: unknown[];
        }[];
      };
      // Today as the visitor sees it, a day ahead of most of the world, falls
      // in the year, and in one of its Terms.
      const today = todayIn("Pacific/Kiritimati");
      expect(academicYears).toHaveLength(1);
      const [year] = academicYears;
      expect(year!.firstDate <= today && today <= year!.lastDate).toBe(true);
      expect(year!.terms).toHaveLength(3);
      expect(year!.terms.filter((term) => term.firstDate <= today && today <= term.lastDate)).toHaveLength(1);
      expect(year!.exceptions).toHaveLength(4);

      const courses = (await school.get("/courses")).body as { courses: unknown[] };
      expect(courses.courses).toHaveLength(5);
      const offerings = (await school.get("/class-offerings")).body as { classOfferings: unknown[] };
      expect(offerings.classOfferings).toHaveLength(6 * 3);
    });

    it("lets the visitor change to each role's account in the same School, each seeing its own invented data", async () => {
      const { client, schoolId } = await server().startTrial();
      const expected = {
        school_administrator: "Morgan Reyes",
        faculty: "Sam Achterberg",
        student: "Jamie Lindqvist",
        guardian: "Alex Lindqvist",
      };

      let current = client;
      for (const role of [...ROLES].reverse()) {
        const previous = current;
        current = await switchRole(current, role);

        const { schools } = await sessionOf(current);
        expect(schools).toEqual([expect.objectContaining({ schoolId, displayName: expected[role], roles: [role], viewingAs: role })]);
        // The Session it was changed from is over.
        expect((await previous.get("/api/session")).body).toEqual(REFUSED);

        const school = current.inSchool(schoolId);
        if (role === "faculty") {
          const taught = (await school.get("/account/class-offerings")).body as { current: unknown[] };
          // Mathematics, in two sections, and Biology, in each of the three Terms.
          expect(taught.current).toHaveLength(9);
        }
        if (role === "student") {
          const { terms } = (await school.get("/account/roster-memberships")).body as {
            terms: { current: boolean; classOfferings: unknown[] }[];
          };
          expect(terms.find((term) => term.current)?.classOfferings).toHaveLength(4);
        }
        if (role === "guardian") {
          const { account } = (await school.get("/account")).body as {
            account: { linkedStudents: { student: { displayName: string } }[] };
          };
          expect(account.linkedStudents.map((link) => link.student.displayName)).toEqual(["Jamie Lindqvist"]);
        }
      }
    });

    it("starts with its Term's Attendance up to yesterday, gaps and all, and a Pending Correction request by its Faculty, auditing none of it", async (context) => {
      const { client, schoolId } = await server().startTrial();
      const school = client.inSchool(schoolId);
      const current = await currentOfferingsOf(school);
      const taken = await Promise.all(current.map(async (offering) => ({ offering, ...(await attendanceOf(school, offering.id)) })));
      const today = taken[0]!.today;
      const pastDays = taken[0]!.dates.map(({ date }) => date).filter((date) => date < today);
      // A Term's first day has no day behind it to have been taken.
      if (pastDays.length === 0) {
        return context.skip();
      }

      const marks = taken.flatMap(({ students }) => students.flatMap((student) => student.attendance));
      const totals = taken.flatMap(({ students }) => students.map((student) => student.totals));
      const sum = (tally: string) => totals.reduce((count, total) => count + total[tally]!, 0);
      expect(marks.every((mark) => pastDays.includes(mark.date))).toBe(true);
      expect(sum("present") / marks.length).toBeGreaterThan(0.8);
      expect(sum("not_recorded")).toBeGreaterThan(0);
      expect(sum("absent_pending_review")).toBe(1);
      // Recorded by whoever teaches each offering.
      const taughtBy = new Set(marks.map((mark) => mark.recordedBy.displayName));
      expect([...taughtBy].sort()).toEqual(["Priya Okonkwo", "Sam Achterberg"]);

      const { correctionRequests } = (await school.get("/correction-requests")).body as { correctionRequests: ServedRequest[] };
      expect(correctionRequests.filter((request) => request.kind === "attendance")).toEqual([
        expect.objectContaining({
          state: "pending",
          requestedBy: expect.objectContaining({ displayName: "Sam Achterberg" }),
          before: "unexcused_absence",
          after: "excused_absence",
        }),
      ]);
      const { auditRecords } = (await school.get("/audit-records")).body as { auditRecords: { action: string }[] };
      expect(auditRecords.map((record) => record.action)).toEqual(["trial.started"]);

      // Its Faculty member finds a past session taken, and today's waiting.
      const faculty = (await switchRole(client, "faculty")).inSchool(schoolId);
      const { current: taught } = (await faculty.get("/account/class-offerings")).body as { current: { id: string }[] };
      const takenTaught = taught.filter((offering) => current.some((candidate) => candidate.id === offering.id));
      expect(takenTaught.length).toBeGreaterThan(0);
      for (const { id } of takenTaught) {
        const past = await attendanceSessionOf(faculty, id, pastDays.at(-1));
        expect(past.opened?.by.displayName).toBe("Sam Achterberg");
        expect(past.students.length).toBeGreaterThan(0);
        expect(past.students.every((student) => student.unmarkableBecause === null)).toBe(true);
        const todays = await attendanceSessionOf(faculty, id);
        expect(todays.opened).toBeNull();
        expect(todays.students).toEqual([]);
      }
      const own = (await faculty.get("/correction-requests")).body as { correctionRequests: ServedRequest[] };
      expect(own.correctionRequests.filter((request) => request.kind === "attendance")).toHaveLength(1);
    });

    it("starts with its Term's results: drafts, one offering published, one that cannot be, and a Pending request on a published result, auditing none of it", async () => {
      const { client, schoolId } = await server().startTrial();
      const school = client.inSchool(schoolId);
      const current = await currentOfferingsOf(school);
      const served = await Promise.all(current.map(async ({ id }) => ({ id, ...(await termResultsOf(school, id)) })));

      // Every roster member has a result, nearly all with a value.
      const results = served.flatMap(({ students }) => students.map((student) => student.termResult));
      expect(results.every((result) => result !== null)).toBe(true);
      expect(results.filter((result) => result!.value === null)).toHaveLength(1);
      // One offering is published whole, and no other in part.
      const published = served.filter(({ students }) => students.every((student) => student.termResult!.publishedAt !== null));
      expect(published).toHaveLength(1);
      expect(results.filter((result) => result!.publishedAt !== null)).toHaveLength(published[0]!.students.length);
      expect(published[0]!.students.map((student) => student.termResult!.recordedBy.displayName)).toContain("Sam Achterberg");
      // One cannot be published, and says who it waits on.
      const waiting = served.filter(({ publication }) => publication.missingValue.length > 0);
      expect(waiting.map(({ publication }) => publication.missingValue.map((student) => student.displayName))).toEqual([
        ["Jordan Okafor"],
      ]);
      const refused = await school.post(`/class-offerings/${waiting[0]!.id}/publications`, {});
      expect(refused.status).toBe(409);
      expect(refused.body).toEqual(
        expect.objectContaining({ conflict: "values_missing", students: [expect.objectContaining({ displayName: "Jordan Okafor" })] }),
      );

      const { correctionRequests } = (await school.get("/correction-requests")).body as { correctionRequests: ServedRequest[] };
      expect(correctionRequests.filter((request) => request.kind === "term_result")).toEqual([
        expect.objectContaining({
          state: "pending",
          classOffering: expect.objectContaining({ id: published[0]!.id }),
          requestedBy: expect.objectContaining({ displayName: "Sam Achterberg" }),
          before: { value: "C", score: 71.5, comment: null },
          after: expect.objectContaining({ value: "B" }),
        }),
      ]);
      const { auditRecords } = (await school.get("/audit-records")).body as { auditRecords: { action: string }[] };
      expect(auditRecords.map((record) => record.action)).toEqual(["trial.started"]);

      // Its Student, and its Guardian, find the published offering's result on the Term report, and no other.
      let visitor = client;
      for (const role of ["student", "guardian"] as const) {
        visitor = await switchRole(visitor, role);
        const reached = visitor.inSchool(schoolId);
        const studentId =
          role === "student"
            ? (await sessionOf(visitor)).schools[0]!.personId
            : ((await reached.get("/account")).body as { account: { linkedStudents: { student: { id: string } }[] } }).account
                .linkedStudents[0]!.student.id;
        const report = await reached.get(`/persons/${studentId}/term-report`);
        expect(report.status).toBe(200);
        const { classOfferings } = (report.body as { termReport: { classOfferings: { id: string; termResult: unknown }[] } })
          .termReport;
        expect(classOfferings.filter((offering) => offering.termResult !== null).map((offering) => offering.id)).toEqual([
          published[0]!.id,
        ]);
      }
    });

    it("lets its only School Administrator approve its Faculty's requests, and approve their own as a marked self-approval", async () => {
      const { client, schoolId } = await server().startTrial();
      const school = client.inSchool(schoolId);
      const { correctionRequests } = (await school.get("/correction-requests")).body as { correctionRequests: ServedRequest[] };
      // A result's always, and an Attendance one unless the trial started on its Term's first day.
      expect(correctionRequests.some((request) => request.kind === "term_result")).toBe(true);
      const approve = async (id: string) => {
        const approved = await school.patch(`/correction-requests/${id}`, { state: "approved" });
        expect(approved.status).toBe(200);
        return (approved.body as { correctionRequest: ServedRequest }).correctionRequest;
      };

      for (const waiting of correctionRequests) {
        expect(await approve(waiting.id)).toEqual(expect.objectContaining({ state: "approved", selfApproved: false }));

        const reason = "The record was read wrong.";
        const raised = await school.post(
          `/class-offerings/${waiting.classOffering.id}/correction-requests`,
          waiting.kind === "attendance"
            ? { kind: "attendance", studentPersonId: waiting.student.id, date: waiting.date, after: "tardy", reason }
            : { kind: "term_result", studentPersonId: waiting.student.id, after: { value: "A", score: null, comment: null }, reason },
        );
        expect(raised.status).toBe(201);
        const own = (raised.body as { correctionRequest: ServedRequest }).correctionRequest;
        expect(await approve(own.id)).toEqual(expect.objectContaining({ state: "approved", selfApproved: true }));
      }
    });

    it("refuses a role that is not a School role, and a caller in no Trial School", async () => {
      const { client } = await server().startTrial();
      for (const body of [{ role: "platform_administrator" }, { role: 7 }, {}]) {
        expect((await client.post("/api/trials/role", body)).body).toEqual(REFUSED);
      }
      // Still signed in as they were.
      expect((await client.get("/api/session")).status).toBe(200);

      const alice = await server().createAccount({ username: "alice", password: "correct horse battery staple" });
      await server().provisionSchool({ name: "Northside", administrator: alice });
      const real = (await server().cookieSessionFor(alice)).withOrigin(server().publicOrigin);
      const refused = await real.post("/api/trials/role", { role: "faculty" });
      const unauthenticated = await server().client.withOrigin(server().publicOrigin).post("/api/trials/role", {
        role: "faculty",
      });
      expect(observable(refused)).toEqual(observable(unauthenticated));
    });

    it("never signs in a role account, whatever password is given", async () => {
      let { client } = await server().startTrial();
      for (const role of ROLES) {
        client = await switchRole(client, role);
        const { account } = await sessionOf(client);
        for (const password of ["", "x", "correct horse battery staple"]) {
          const response = await server().client.post("/api/session", { username: account.username, password, session: "bearer" });
          expect(response.body).toEqual(REFUSED);
        }
      }
    });

    it("takes the School's timezone from the visitor, falling back to UTC for one it does not know", async () => {
      for (const timezone of ["Mars/Olympus_Mons", "", undefined]) {
        const { client, schoolId } = await server().startTrial(timezone === undefined ? {} : { timezone });
        const settings = (await client.inSchool(schoolId).get("/settings")).body as { settings: { timezone: string } };
        expect(settings.settings.timezone).toBe("UTC");
      }
    });

    it("ends every Session in a Trial School once it expires, as a Safe denial", async () => {
      const { client, schoolId } = await server().startTrial();
      const student = await switchRole(client, "student");
      await server().expireTrialSchool(schoolId);

      const stranger = server().client.withOrigin(server().publicOrigin);
      for (const path of ["/api/session", `/api/schools/${schoolId}/persons`]) {
        expect(observable(await student.get(path))).toEqual(observable(await stranger.get(path)));
      }
      expect(observable(await student.post("/api/trials/role", { role: "faculty" }))).toEqual(
        observable(await stranger.post("/api/trials/role", { role: "faculty" })),
      );
    });

    it("deletes expired Trial Schools when the next trial starts, and no other School", async () => {
      const alice = await server().createAccount({ username: "alice", password: "correct horse battery staple" });
      const { school: real } = await server().provisionSchool({ name: "Northside", administrator: alice });
      const expired = await server().startTrial();
      const live = await server().startTrial();
      await server().expireTrialSchool(expired.schoolId);

      const next = await server().startTrial();

      const { rows } = await server().database.query<{ id: string }>("SELECT id FROM app.school ORDER BY id");
      expect(rows.map((row) => row.id).sort()).toEqual([real.id, live.schoolId, next.schoolId].sort());
    });

    it("lets a trial's School Administrator invite a Person, whose new account ends and goes with the trial", async () => {
      const { client, schoolId } = await server().startTrial();
      const school = client.inSchool(schoolId);
      const { persons } = (await school.get("/persons")).body as { persons: { id: string; displayName: string }[] };
      const priya = persons.find((person) => person.displayName === "Priya Okonkwo")!;
      const issued = await school.post("/invitations", { personId: priya.id });
      expect(issued.status).toBe(201);
      const secret = (issued.body as { link: string }).link.split("#")[1];

      const credentials = { username: "priya", password: "correct horse battery staple" };
      const redeemed = await server()
        .client.withOrigin(server().publicOrigin)
        .post("/api/invitations/redeem", { secret, ...credentials });
      expect(redeemed.status).toBe(201);
      const priyas = server().client.withOrigin(server().publicOrigin).withCookie(cookieSentBackFor(redeemed));
      expect((await sessionOf(priyas)).schools).toEqual([
        expect.objectContaining({ schoolId, displayName: "Priya Okonkwo", roles: ["faculty"] }),
      ]);
      // An account the trial did not make for a role acts as no role of the trial's, and cannot change to one.
      expect((await sessionOf(priyas)).schools[0]).not.toHaveProperty("viewingAs");
      expect((await priyas.post("/api/trials/role", { role: "school_administrator" })).body).toEqual(REFUSED);

      await server().expireTrialSchool(schoolId);
      expect((await priyas.get("/api/session")).body).toEqual(REFUSED);
      await server().startTrial();
      // Deleted with the trial, so the username is free and the password verifies as nothing.
      expect((await server().client.post("/api/session", { ...credentials, session: "bearer" })).body).toEqual(REFUSED);
      await server().createAccount(credentials);
    });

    it("offers no way to start one without signing in", async () => {
      const browser = server().client.withOrigin(server().publicOrigin);
      expect((await browser.post("/api/trials", {})).body).toEqual(REFUSED);
      const { rows } = await server().database.query("SELECT 1 FROM app.school");
      expect(rows).toHaveLength(0);
    });
  });

  // ADR-0013: the visitor proves an outside identity, and SchoolGrid keeps
  // nothing of it but a keyed hash.
  describe("signing in to start one", () => {
    const server = useTestServer({ trials: { enabled: true } });

    /** How many Schools there are: a sign-in that should start nothing must leave none. */
    async function schoolCount(): Promise<number> {
      const { rows } = await server().ownerDatabase.query<{ count: number }>("SELECT count(*)::integer AS count FROM app.school");
      return rows[0]!.count;
    }

    it("sends the visitor to the provider with a state and a PKCE challenge, remembering the flow in a short-lived cookie", async () => {
      const { location, flowCookie } = await server().beginTrialSignIn({ timezone: "Europe/Oslo" });

      expect(`${location.origin}${location.pathname}`).toBe(`${server().fakeProvider!.url}/authorize`);
      expect(Object.fromEntries(location.searchParams)).toEqual({
        response_type: "code",
        client_id: "schoolgrid-test",
        redirect_uri: `${server().publicOrigin}/api/trials/callback/github`,
        state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        code_challenge_method: "S256",
      });
      expect(flowCookie).toMatch(/^__Secure-trial-sign-in=/);
      const response = await server().client.withHeader("sec-fetch-site", "same-origin").get("/api/trials/start/github");
      expect(setCookiesOf(response)).toEqual([
        expect.stringMatching(/; Path=\/api\/trials\/callback; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/),
      ]);
      // Two sign-ins never share a state.
      expect((await server().beginTrialSignIn()).location.searchParams.get("state")).not.toBe(location.searchParams.get("state"));
    });

    it("lands the visitor in their new School, signed in, and forgets the flow", async () => {
      const signIn = await server().beginTrialSignIn();
      const callback = await server().answerAtProvider(signIn, { decision: "approve" });

      const response = await server().client.withCookie(signIn.flowCookie).get(callback);

      expect(response.status).toBe(303);
      expect(response.headers.location).toMatch(/^\/schools\/[0-9a-f-]{36}\/persons$/);
      expect(setCookiesOf(response)).toEqual([
        "__Secure-trial-sign-in=; Path=/api/trials/callback; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
        expect.stringMatching(/^__Host-session=[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Strict$/),
      ]);
    });

    it("keeps only a keyed hash of the provider and subject, one Trial visitor and School for each identity", async () => {
      const subject = "583231";
      const first = await server().startTrial({ subject });
      await server().expireTrialSchool(first.schoolId);
      await server().startTrial({ subject: "9001" });
      await server().startTrial({ subject });

      const { rows } = await server().ownerDatabase.query<{ identity: Buffer; schools: number }>(
        `SELECT visitor.identity, count(school.id)::integer AS schools
         FROM app.trial_visitor visitor JOIN app.school school ON school.trial_visitor_id = visitor.id
         GROUP BY visitor.id ORDER BY visitor.created_at DESC`,
      );
      expect(rows.map((row) => row.schools)).toEqual([1, 1]);
      const expected = createHmac("sha256", createHmac("sha256", TEST_IDENTITY_KEY).update("schoolgrid-trial-identity").digest())
        .update(`github:${subject}`)
        .digest();
      expect(rows[0]!.identity.equals(expected)).toBe(true);
      for (const { identity } of rows) {
        expect(identity.toString("latin1")).not.toContain(subject);
        expect(identity.toString("latin1")).not.toContain("github");
      }
    });

    it("returns a visitor to their live trial as its School Administrator, in a new Session, recorded as a sign-in is", async () => {
      const subject = "583231";
      const first = await server().startTrial({ subject });
      await switchRole(first.client, "faculty");

      const again = await server().startTrial({ subject });

      expect(again.schoolId).toBe(first.schoolId);
      expect(again.expiresAt).toBe(first.expiresAt);
      const { schools } = await sessionOf(again.client);
      expect(schools.map((school) => school.roles)).toEqual([["school_administrator"]]);
      expect(await schoolCount()).toBe(1);
      const { rows } = await server().ownerDatabase.query<{ action: string; actor: string | null }>(
        `SELECT action, person.display_name AS actor
         FROM app.audit_record LEFT JOIN app.person person ON person.id = actor_person_id
         WHERE audit_record.school_id = $1 AND action LIKE 'authentication.%'
         ORDER BY audit_record.occurred_at`,
        [first.schoolId],
      );
      // The role change to Faculty, then the return as the School Administrator.
      expect(rows).toEqual([
        { action: "authentication.succeeded", actor: expect.any(String) },
        { action: "authentication.succeeded", actor: schools[0]!.displayName },
      ]);
    });

    it("sends a Google visitor to Google asking only for `openid`, to come back to Google's own callback", async () => {
      const { location } = await server().beginTrialSignIn({ provider: "google" });

      expect(Object.fromEntries(location.searchParams)).toEqual(
        expect.objectContaining({ scope: "openid", redirect_uri: `${server().publicOrigin}/api/trials/callback/google` }),
      );
      // GitHub reads only what is public, so it is asked for no scope at all.
      expect((await server().beginTrialSignIn()).location.searchParams.has("scope")).toBe(false);
    });

    it("starts a trial for a Google visitor, and returns them to it, as for a GitHub one", async () => {
      const first = await server().startTrial({ provider: "google", subject: "110248495921238986420" });

      const again = await server().startTrial({ provider: "google", subject: "110248495921238986420" });

      expect(again.schoolId).toBe(first.schoolId);
      expect(await schoolCount()).toBe(1);
      const { rows } = await server().ownerDatabase.query<{ identity: Buffer }>("SELECT identity FROM app.trial_visitor");
      const expected = createHmac("sha256", createHmac("sha256", TEST_IDENTITY_KEY).update("schoolgrid-trial-identity").digest())
        .update("google:110248495921238986420")
        .digest();
      expect(rows.map((row) => row.identity.equals(expected))).toEqual([true]);
    });

    it("counts the same subject at GitHub and at Google as two Trial visitors, with two Schools", async () => {
      const github = await server().startTrial({ provider: "github", subject: "583231" });
      const google = await server().startTrial({ provider: "google", subject: "583231" });

      expect(google.schoolId).not.toBe(github.schoolId);
      expect(await schoolCount()).toBe(2);
      const { rows } = await server().ownerDatabase.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM app.trial_visitor",
      );
      expect(rows[0]!.count).toBe(2);
    });

    it("starts a new School at once for a visitor whose trial has expired", async () => {
      const first = await server().startTrial({ subject: "583231" });
      await server().expireTrialSchool(first.schoolId);

      const again = await server().startTrial({ subject: "583231" });

      expect(again.schoolId).not.toBe(first.schoolId);
      expect(await schoolCount()).toBe(1);
    });

    it("starts at most one School for one visitor signing in twice at once", async () => {
      const signIns = await Promise.all([server().beginTrialSignIn(), server().beginTrialSignIn()]);
      const callbacks = await Promise.all(
        signIns.map((signIn) => server().answerAtProvider(signIn, { decision: "approve", subject: "583231" })),
      );

      const responses = await Promise.all(
        signIns.map((signIn, index) => server().client.withCookie(signIn.flowCookie).get(callbacks[index]!)),
      );

      const [first, second] = responses.map((response) => response.headers.location);
      expect(first).toMatch(/^\/schools\/[0-9a-f-]{36}\/persons$/);
      expect(second).toBe(first);
      expect(await schoolCount()).toBe(1);
    });

    it("sends a visitor who cancels at the provider back to the front page, starting nothing", async () => {
      const signIn = await server().beginTrialSignIn();
      const callback = await server().answerAtProvider(signIn, { decision: "cancel" });

      const response = await server().client.withCookie(signIn.flowCookie).get(callback);

      expect(response.status).toBe(303);
      expect(response.headers.location).toBe("/?trial=cancelled");
      expect(setCookiesOf(response)).toEqual([expect.stringMatching(/^__Secure-trial-sign-in=; .*Max-Age=0$/)]);
      expect(await schoolCount()).toBe(0);
    });

    it("starts nothing for a redirect back this browser did not begin, or with the wrong verifier", async () => {
      const signIn = await server().beginTrialSignIn();
      const other = await server().beginTrialSignIn();
      const callback = await server().answerAtProvider(signIn, { decision: "approve" });
      const [payload, signature] = signIn.flowCookie.slice(signIn.flowCookie.indexOf("=") + 1).split(".");
      const tampered = Buffer.from(
        JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), expiresAt: Date.now() + 3_600_000 }),
      ).toString("base64url");
      const withState = (state: string) => callback.replace(/state=[^&]+/, `state=${state}`);
      // Signed as the server signs, so only the verifier is wrong: the provider refuses it.
      const flowKey = createHmac("sha256", TEST_IDENTITY_KEY).update("schoolgrid-trial-flow").digest();
      const wrongVerifier = Buffer.from(
        JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), verifier: "x".repeat(43) }),
      ).toString("base64url");
      const resigned = `__Secure-trial-sign-in=${wrongVerifier}.${createHmac("sha256", flowKey).update(wrongVerifier).digest("base64url")}`;

      for (const [cookie, path] of [
        [resigned, callback],
        [undefined, callback],
        [other.flowCookie, callback],
        [signIn.flowCookie, withState(other.location.searchParams.get("state")!)],
        [signIn.flowCookie, withState("")],
        [`__Secure-trial-sign-in=${tampered}.${signature}`, callback],
        [`${signIn.flowCookie}; ${other.flowCookie}`, callback],
        [signIn.flowCookie, callback.replace(/code=[^&]+/, "code=forged")],
      ] as const) {
        const client = cookie === undefined ? server().client : server().client.withCookie(cookie);
        const response = await client.get(path);
        expect(response.headers.location).toBe("/?trial=failed");
        expect(setCookiesOf(response).some((set) => set.startsWith("__Host-session="))).toBe(false);
      }
      expect(await schoolCount()).toBe(0);
    });

    it("starts nothing for a code already used", async () => {
      const signIn = await server().beginTrialSignIn();
      const callback = await server().answerAtProvider(signIn, { decision: "approve" });
      const browser = server().client.withCookie(signIn.flowCookie);
      expect((await browser.get(callback)).headers.location).toMatch(/^\/schools\//);

      expect((await browser.get(callback)).headers.location).toBe("/?trial=failed");
      expect(await schoolCount()).toBe(1);
    });

    it("refuses a start another site sent the browser to, or that no page of its own did", async () => {
      for (const site of [undefined, "cross-site", "same-site", "none"]) {
        const client = site === undefined ? server().client : server().client.withHeader("sec-fetch-site", site);
        const response = await client.get("/api/trials/start/github");
        expect(response.status).toBe(404);
        expect(response.body).toEqual(REFUSED);
        expect(response.headers["set-cookie"]).toBeUndefined();
      }
    });

    it("refuses a provider it does not know", async () => {
      for (const path of ["/api/trials/start/nobody", "/api/trials/callback/nobody"]) {
        const response = await server().client.withHeader("sec-fetch-site", "same-origin").get(path);
        expect(response.status).toBe(404);
        expect(response.body).toEqual(REFUSED);
      }
    });
  });

  describe("with trials on and only one provider configured", () => {
    const server = useTestServer({ trials: { enabled: true, providers: ["google"] } });

    it("offers only that one, and refuses a sign-in with the other", async () => {
      expect((await server().client.get("/api/trials")).body).toEqual({ enabled: true, providers: ["google"] });
      for (const path of ["/api/trials/start/github", "/api/trials/callback/github?code=x&state=y"]) {
        const response = await server().client.withHeader("sec-fetch-site", "same-origin").get(path);
        expect(response.status).toBe(404);
        expect(response.body).toEqual(REFUSED);
        expect(response.headers["set-cookie"]).toBeUndefined();
      }
      expect((await server().startTrial({ provider: "google" })).schoolId).toEqual(expect.any(String));
    });
  });

  describe("with trials on and no provider configured", () => {
    const server = useTestServer({ trials: { enabled: true, providers: [] } });

    it("offers no provider, and refuses a sign-in with one", async () => {
      expect((await server().client.get("/api/trials")).body).toEqual({ enabled: true, providers: [] });
      expect((await server().client.get("/api/trials/start/github")).body).toEqual(REFUSED);
    });
  });

  // The one way a School or an Audit record is ever deleted, fenced in the
  // database rather than the application (ADR-0012).
  describe("deletion, as the application's database role", () => {
    const server = useTestServer({ trials: { enabled: true } });

    /** Every School-scoped table, and how many rows each holds for this School. */
    async function rowsIn(schoolId: string): Promise<Record<string, number>> {
      const tables = [
        "person", "school_membership", "enrollment", "guardian_link", "invitation", "audit_record",
        "academic_year", "term", "instructional_day_exception", "course", "class_offering",
        "teaching_assignment", "roster_membership", "attendance_session", "roster_snapshot_member", "attendance",
        "correction_request", "result_value_scale_version", "result_value", "term_result", "publication",
      ];
      const counts: Record<string, number> = {};
      for (const table of tables) {
        const { rows } = await server().ownerDatabase.query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM app.${table} WHERE school_id = $1`,
          [schoolId],
        );
        counts[table] = rows[0]!.count;
      }
      return counts;
    }

    it("is refused a direct delete of any School or Audit record, a trial's included", async () => {
      const { schoolId } = await server().startTrial();
      await server().expireTrialSchool(schoolId);

      for (const table of ["school", "audit_record"]) {
        await expect(server().database.query(`DELETE FROM app.${table}`)).rejects.toThrow(
          new RegExp(`permission denied for table ${table}`),
        );
      }
    });

    it("may delete only a Trial School past its expiry, and refuses a real School or a live trial", async () => {
      const alice = await server().createAccount({ username: "alice", password: "correct horse battery staple" });
      const { school: real } = await server().provisionSchool({ name: "Northside", administrator: alice });
      const live = await server().startTrial();

      for (const schoolId of [real.id, live.schoolId]) {
        await expect(
          server().database.query("SELECT app.delete_expired_trial_school($1)", [schoolId]),
        ).rejects.toThrow(/only a Trial School past its expiry may be deleted/);
      }
      expect((await rowsIn(real.id))["audit_record"]).toBeGreaterThan(0);
      expect((await rowsIn(live.schoolId))["person"]).toBe(INVENTED_PERSONS.length);
    });

    it("deletes an expired Trial School whole: its records, its Audit records and the accounts created in it", async () => {
      const { schoolId } = await server().startTrial();
      const before = await rowsIn(schoolId);
      expect(before["audit_record"]).toBeGreaterThan(0);
      for (const table of ["roster_membership", "result_value_scale_version", "term_result", "publication"]) {
        expect(before[table]).toBeGreaterThan(0);
      }
      await server().expireTrialSchool(schoolId);

      const { rows } = await server().database.query<{ deleted: boolean }>(
        "SELECT app.delete_expired_trial_school($1) AS deleted",
        [schoolId],
      );

      expect(rows[0]!.deleted).toBe(true);
      expect(Object.values(await rowsIn(schoolId)).every((count) => count === 0)).toBe(true);
      const accounts = await server().ownerDatabase.query("SELECT 1 FROM app.user_account");
      expect(accounts.rows).toHaveLength(0);
      const schools = await server().ownerDatabase.query("SELECT 1 FROM app.school");
      expect(schools.rows).toHaveLength(0);
      const visitors = await server().ownerDatabase.query("SELECT 1 FROM app.trial_visitor");
      expect(visitors.rows).toHaveLength(0);
    });

    it("forgets a Trial visitor only once no Trial School of theirs remains", async () => {
      await server().startTrial({ subject: "kept" });
      const alone = await server().startTrial({ subject: "forgotten" });
      await server().expireTrialSchool(alone.schoolId);

      await server().database.query("SELECT app.delete_expired_trial_schools()");

      const { rows } = await server().ownerDatabase.query<{ schools: number }>(
        `SELECT count(school.id)::integer AS schools
         FROM app.trial_visitor visitor LEFT JOIN app.school school ON school.trial_visitor_id = visitor.id
         GROUP BY visitor.id`,
      );
      expect(rows).toEqual([{ schools: 1 }]);
    });

    it("cannot change whose a Trial School is, or name a visitor for a real School", async () => {
      const { schoolId } = await server().startTrial();
      await expect(server().database.query("UPDATE app.school SET trial_visitor_id = NULL WHERE id = $1", [schoolId])).rejects.toThrow(
        /permission denied for table school/,
      );
      await expect(server().database.query("DELETE FROM app.trial_visitor")).rejects.toThrow(
        /permission denied for table trial_visitor/,
      );
      const { rows } = await server().database.query<{ id: string }>("SELECT id FROM app.trial_visitor");
      await expect(
        server().database.query("INSERT INTO app.school (name, timezone, trial_visitor_id) VALUES ('Real', 'UTC', $1)", [rows[0]!.id]),
      ).rejects.toThrow(/school_trial_visitor_only_on_trials/);
    });

    it("cannot give a role account a password, or stop it being one", async () => {
      const { client } = await server().startTrial();
      const { account } = await sessionOf(client);

      await expect(
        server().database.query("UPDATE app.user_account SET password_hash = 'scrypt$1$1$1$c2FsdA==$a2V5' WHERE username = $1", [
          account.username,
        ]),
      ).rejects.toThrow(/user_account_password_check/);
      await expect(
        server().database.query("UPDATE app.user_account SET trial_role = NULL WHERE username = $1", [account.username]),
      ).rejects.toThrow(/permission denied for table user_account/);
    });
  });

  describe("at most so many live at once", () => {
    const server = useTestServer({ trials: { enabled: true, liveCap: 2 } });

    it("sends the visitor back to say it is busy once the cap is reached, and starts again once one has expired", async () => {
      const first = await server().startTrial();
      await server().startTrial();

      const signIn = await server().beginTrialSignIn();
      const callback = await server().answerAtProvider(signIn, { decision: "approve" });
      const busy = await server().client.withCookie(signIn.flowCookie).get(callback);
      expect(busy.status).toBe(303);
      expect(busy.headers.location).toBe("/?trial=busy");
      expect(setCookiesOf(busy)).toEqual([expect.stringMatching(/^__Secure-trial-sign-in=; .*Max-Age=0$/)]);

      await server().expireTrialSchool(first.schoolId);
      await server().startTrial();
    });

    it("returns a visitor to their live trial even once the cap is reached", async () => {
      const first = await server().startTrial({ subject: "583231" });
      await server().startTrial();

      const again = await server().startTrial({ subject: "583231" });

      expect(again.schoolId).toBe(first.schoolId);
    });
  });

  describe("with trials off, as they are unless enabled", () => {
    const server = useTestServer();

    it("says trials are not offered", async () => {
      const response = await server().client.get("/api/trials");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ enabled: false, providers: [] });
    });

    it("refuses to start one, or to change role", async () => {
      const browser = server().client.withOrigin(server().publicOrigin);
      for (const [method, path] of [
        ["GET", "/api/trials/start/github"],
        ["GET", "/api/trials/callback/github?code=x&state=y"],
        ["POST", "/api/trials/role"],
      ] as const) {
        const response = await browser.request(method, path, method === "POST" ? { role: "faculty" } : undefined);
        expect(response.status).toBe(404);
        expect(response.body).toEqual(REFUSED);
        expect(response.headers["set-cookie"]).toBeUndefined();
      }
      const { rows } = await server().database.query("SELECT 1 FROM app.school");
      expect(rows).toHaveLength(0);
    });
  });
});
