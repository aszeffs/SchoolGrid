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
  displayName: string;
  roles: string[];
  trialExpiresAt?: string;
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

describe("Trial Schools", () => {
  describe("with trials on", () => {
    const server = useTestServer({ trials: { enabled: true, perClientPerHour: 1000 } });

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
          trialExpiresAt: expiresAt,
        },
      ]);

      const school = client.inSchool(schoolId);
      const settings = (await school.get("/settings")).body as { settings: { timezone: string } };
      expect(settings.settings.timezone).toBe("Pacific/Kiritimati");

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
        expect(schools).toEqual([expect.objectContaining({ schoolId, displayName: expected[role], roles: [role] })]);
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
      // An account the trial did not make for a role cannot change to one.
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
        "teaching_assignment", "roster_membership",
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
      expect(before["roster_membership"]).toBeGreaterThan(0);
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
