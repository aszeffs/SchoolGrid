import { describe, expect, it } from "vitest";
import { cookieSentBackFor, observable, useTestServer, type TestClient } from "./support/harness.ts";

const ROLES = ["school_administrator", "faculty", "student", "guardian"] as const;

const REFUSED = { status: "refused" };
const BUSY = { status: "busy" };

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
    const server = useTestServer({ trials: { enabled: true, perClientPerHour: 1000 } });

    it("says trials are offered, to anyone, with no Session", async () => {
      const response = await server().client.get("/api/trials");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ enabled: true });
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

    it("starts over in a fresh Trial School, ending the Session the browser held in the last", async () => {
      const { client, schoolId } = await server().startTrial();
      const started = await client.post("/api/trials", {});
      expect(started.status).toBe(201);

      expect((await client.get("/api/session")).body).toEqual(REFUSED);
      const { schools } = await sessionOf(client.withCookie(cookieSentBackFor(started)));
      expect(schools).toEqual([expect.objectContaining({ viewingAs: "school_administrator" })]);
      expect(schools[0]!.schoolId).not.toBe(schoolId);
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

    it("refuses a start from another site, which could plant its Session in the visitor's browser", async () => {
      for (const client of [server().client, server().client.withOrigin("https://attacker.example")]) {
        const response = await client.post("/api/trials", {});
        expect(response.body).toEqual(REFUSED);
        expect(response.headers["set-cookie"]).toBeUndefined();
      }
    });
  });

  // The one way a School or an Audit record is ever deleted, fenced in the
  // database rather than the application (ADR-0012).
  describe("deletion, as the application's database role", () => {
    const server = useTestServer({ trials: { enabled: true, perClientPerHour: 1000 } });

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
    const server = useTestServer({ trials: { enabled: true, liveCap: 2, perClientPerHour: 1000 } });

    it("answers busy once the cap is reached, and starts again once one has expired", async () => {
      const first = await server().startTrial();
      await server().startTrial();

      const browser = server().client.withOrigin(server().publicOrigin);
      const busy = await browser.post("/api/trials", {});
      expect(busy.status).toBe(503);
      expect(busy.body).toEqual(BUSY);
      expect(busy.headers["set-cookie"]).toBeUndefined();

      await server().expireTrialSchool(first.schoolId);
      expect((await browser.post("/api/trials", {})).status).toBe(201);
    });
  });

  describe("at most so many started per client an hour", () => {
    const server = useTestServer({ trials: { enabled: true, perClientPerHour: 2 } });

    it("answers busy to a client over the limit, and not to another", async () => {
      await server().startTrial({ from: "203.0.113.7" });
      await server().startTrial({ from: "203.0.113.7" });

      const busy = await server().client.withOrigin(server().publicOrigin).fromAddress("203.0.113.7").post("/api/trials", {});
      expect(busy.status).toBe(429);
      expect(busy.body).toEqual(BUSY);
      expect(Number(busy.headers["retry-after"])).toBeGreaterThan(0);

      await server().startTrial({ from: "203.0.113.8" });
    });
  });

  describe("with trials off, as they are unless enabled", () => {
    const server = useTestServer();

    it("says trials are not offered", async () => {
      const response = await server().client.get("/api/trials");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ enabled: false });
    });

    it("refuses to start one, or to change role", async () => {
      const browser = server().client.withOrigin(server().publicOrigin);
      for (const [path, body] of [
        ["/api/trials", { timezone: "UTC" }],
        ["/api/trials/role", { role: "faculty" }],
      ] as const) {
        const response = await browser.post(path, body);
        expect(response.status).toBe(404);
        expect(response.body).toEqual(REFUSED);
      }
      const { rows } = await server().database.query("SELECT 1 FROM app.school");
      expect(rows).toHaveLength(0);
    });
  });
});
