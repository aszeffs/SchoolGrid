import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { useTestServer, type TestClient, type TestServer } from "./support/harness.ts";

/** Written out here rather than imported, as in the security headers suite. */
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
} as const;

/** The sign-ins the demo publishes, written out as a visitor reads them off the page. */
const PUBLISHED = [
  { role: "school_administrator", username: "demo.administrator", password: "try-schoolgrid-administrator" },
  { role: "faculty", username: "demo.faculty", password: "try-schoolgrid-faculty" },
  { role: "student", username: "demo.student", password: "try-schoolgrid-student" },
  { role: "guardian", username: "demo.guardian", password: "try-schoolgrid-guardian" },
] as const;

type PublishedRole = (typeof PUBLISHED)[number]["role"];

/** The Persons the seed invents beyond the four who sign in, none of whom has a User account. */
const INVENTED_FACULTY = ["Priya Okonkwo"];
const INVENTED_STUDENTS = [
  "Avery Castellano",
  "Casey Moreau",
  "Jordan Okafor",
  "Quinn Adebayo",
  "Riley Fernsby",
  "Taylor Nakamura",
];

const SEED = new URL("../demo/seed.sql", import.meta.url);

/**
 * Runs the seed as the maintainer does: as the schema owner, against a freshly
 * migrated database. Given a School date, the seed builds around that day
 * rather than the one it runs on, as `demo.today` asks it to.
 */
async function seed(server: TestServer, today?: string): Promise<void> {
  const sql = await readFile(SEED, "utf8");
  await server.ownerDatabase.query(today === undefined ? sql : `SET demo.today = '${today}';
${sql}
RESET demo.today;`);
}

function securityHeadersOf(headers: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(SECURITY_HEADERS).map((name) => [name, headers[name]]));
}

describe("GET /api/demo", () => {
  describe("with demo mode on", () => {
    const server = useTestServer({ demoMode: true });

    it("publishes a sign-in for each School role, and none for a Platform Administrator", async () => {
      const response = await server().client.get("/api/demo");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ accounts: PUBLISHED });
    });

    it("needs no session, and carries the security headers", async () => {
      const response = await server().client.get("/api/demo");

      expect(response.status).toBe(200);
      expect(securityHeadersOf(response.headers)).toEqual(SECURITY_HEADERS);
    });
  });

  // Everywhere but the public demo. Its accounts do not exist there, and a
  // sign-in page offering them would be offering something that cannot work.
  describe("with demo mode off", () => {
    const server = useTestServer();

    it("publishes no sign-ins", async () => {
      const response = await server().client.get("/api/demo");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ accounts: [] });
    });
  });
});

describe("the demo seed", () => {
  const server = useTestServer({ demoMode: true });

  /** Signs in with each published sign-in, as a visitor would from the page. */
  async function signInAsEach(): Promise<Record<PublishedRole, TestClient>> {
    const { body } = await server().client.get("/api/demo");
    const { accounts } = body as { accounts: { role: PublishedRole; username: string; password: string }[] };
    const clients: Partial<Record<PublishedRole, TestClient>> = {};
    for (const { role, username, password } of accounts) {
      clients[role] = await server().signIn({ username, password });
    }
    return clients as Record<PublishedRole, TestClient>;
  }

  async function onlySchoolOf(client: TestClient): Promise<{ id: string; name: string }> {
    const response = await client.get("/api/schools");
    expect(response.status).toBe(200);
    const { schools } = response.body as { schools: { id: string; name: string }[] };
    expect(schools).toHaveLength(1);
    return schools[0]!;
  }

  async function personsSeenBy(client: TestClient, schoolId: string): Promise<string[]> {
    const response = await client.inSchool(schoolId).get("/persons");
    expect(response.status).toBe(200);
    const { persons } = response.body as { persons: { displayName: string }[] };
    return persons.map(({ displayName }) => displayName).sort();
  }

  it("lets every published sign-in in, each to the one invented School", async () => {
    await seed(server());
    const clients = await signInAsEach();

    const schools = await Promise.all(Object.values(clients).map(onlySchoolOf));

    expect(schools).toHaveLength(4);
    expect(new Set(schools.map(({ id }) => id)).size).toBe(1);
    expect(schools[0]!.name).toBe("Riverbend Demo School");
  });

  it("shows each role only what it allows", async () => {
    await seed(server());
    const clients = await signInAsEach();
    const { id: schoolId } = await onlySchoolOf(clients.school_administrator);

    expect(await personsSeenBy(clients.school_administrator, schoolId)).toEqual(
      [
        "Alex Lindqvist",
        "Jamie Lindqvist",
        "Morgan Reyes",
        "Sam Achterberg",
        ...INVENTED_FACULTY,
        ...INVENTED_STUDENTS,
      ].sort(),
    );
    expect(await personsSeenBy(clients.faculty, schoolId)).toEqual(["Sam Achterberg"]);
    expect(await personsSeenBy(clients.student, schoolId)).toEqual(["Jamie Lindqvist"]);
    // The Guardian reaches the Student they are linked to, and no one else.
    expect(await personsSeenBy(clients.guardian, schoolId)).toEqual(["Alex Lindqvist", "Jamie Lindqvist"]);

    expect((await clients.school_administrator.inSchool(schoolId).get("/audit-records")).status).toBe(200);
    for (const role of ["faculty", "student", "guardian"] as const) {
      expect((await clients[role].inSchool(schoolId).get("/audit-records")).status).toBe(404);
    }
  });

  it("enrolls every Student, and links the Guardian to them with a full Access profile", async () => {
    await seed(server());
    const clients = await signInAsEach();
    const { id: schoolId } = await onlySchoolOf(clients.school_administrator);
    const administrator = clients.school_administrator.inSchool(schoolId);

    const persons = (await administrator.get("/persons")).body as { persons: { id: string; displayName: string }[] };
    const idOf = (name: string) => persons.persons.find(({ displayName }) => displayName === name)!.id;
    const enrollments = (await administrator.get("/enrollments")).body as {
      enrollments: { studentPersonId: string; endedAt: string | null }[];
    };
    const links = (await administrator.get("/guardian-links")).body as {
      guardianLinks: { guardianPersonId: string; studentPersonId: string; accessProfile: unknown; endedAt: unknown }[];
    };

    expect(enrollments.enrollments).toEqual(
      expect.arrayContaining(
        ["Jamie Lindqvist", ...INVENTED_STUDENTS].map((name) =>
          expect.objectContaining({ studentPersonId: idOf(name), endedAt: null }),
        ),
      ),
    );
    expect(enrollments.enrollments).toHaveLength(1 + INVENTED_STUDENTS.length);
    expect(links.guardianLinks).toEqual([
      expect.objectContaining({
        guardianPersonId: idOf("Alex Lindqvist"),
        studentPersonId: idOf("Jamie Lindqvist"),
        accessProfile: { attendanceRead: true, resultsRead: true },
        endedAt: null,
      }),
    ]);
  });

  it("builds an Academic Year around the day it runs, divided into Terms, with a few holidays", async () => {
    await seed(server());
    const clients = await signInAsEach();
    const { id: schoolId } = await onlySchoolOf(clients.school_administrator);
    const administrator = clients.school_administrator.inSchool(schoolId);
    const { schoolDate: today } = (await administrator.get("/school-date")).body as { schoolDate: string };

    const { academicYears } = (await administrator.get("/academic-years")).body as {
      academicYears: {
        firstDate: string;
        lastDate: string;
        weekdays: string[];
        exceptions: { date: string; instructional: boolean }[];
        instructionalDays: string[];
        terms: { name: string; firstDate: string; lastDate: string }[];
      }[];
    };

    expect(academicYears).toHaveLength(1);
    const [year] = academicYears as [(typeof academicYears)[number]];
    expect(year.firstDate <= today && today <= year.lastDate).toBe(true);
    expect(year.terms.length).toBeGreaterThan(1);
    expect(year.terms.filter((term) => term.firstDate <= today && today <= term.lastDate)).toHaveLength(1);
    expect(year.weekdays).toEqual(["monday", "tuesday", "wednesday", "thursday", "friday"]);
    // Holidays, each a weekday the pattern would otherwise have taught on.
    expect(year.exceptions.length).toBeGreaterThanOrEqual(3);
    for (const { date, instructional } of year.exceptions) {
      expect(instructional).toBe(false);
      expect(year.firstDate <= date && date <= year.lastDate).toBe(true);
      expect(new Date(`${date}T00:00:00Z`).getUTCDay()).not.toBeOneOf([0, 6]);
      expect(year.instructionalDays).not.toContain(date);
    }
  });

  it("offers several Courses in every Term, taught by the Faculty member, with the Student among others", async () => {
    await seed(server());
    const clients = await signInAsEach();
    const { id: schoolId } = await onlySchoolOf(clients.school_administrator);
    const administrator = clients.school_administrator.inSchool(schoolId);

    const { courses } = (await administrator.get("/courses")).body as { courses: unknown[] };
    const { classOfferings } = (await administrator.get("/class-offerings")).body as {
      classOfferings: { id: string; term: { id: string } }[];
    };
    const { academicYears } = (await administrator.get("/academic-years")).body as {
      academicYears: { terms: { id: string }[] }[];
    };
    expect(courses.length).toBeGreaterThanOrEqual(3);
    for (const term of academicYears[0]!.terms) {
      expect(classOfferings.filter((offering) => offering.term.id === term.id).length).toBeGreaterThanOrEqual(3);
    }

    // The Faculty member teaches something now.
    const taught = (await clients.faculty.inSchool(schoolId).get("/account/class-offerings")).body as {
      current: { id: string }[];
    };
    expect(taught.current.length).toBeGreaterThan(0);

    // The Student has classes in the Term running today, and in every other.
    const rostered = (await clients.student.inSchool(schoolId).get("/account/roster-memberships")).body as {
      terms: { current: boolean; classOfferings: { teachingAssignments: unknown[] }[] }[];
    };
    expect(rostered.terms).toHaveLength(academicYears[0]!.terms.length);
    expect(rostered.terms[0]!.current).toBe(true);
    for (const term of rostered.terms) {
      expect(term.classOfferings.length).toBeGreaterThan(0);
      for (const offering of term.classOfferings) {
        expect(offering.teachingAssignments.length).toBeGreaterThan(0);
      }
    }

    // Each class the Faculty member teaches now has a roster of several Students.
    for (const { id } of taught.current) {
      const { classOffering } = (await clients.faculty.inSchool(schoolId).get(`/class-offerings/${id}`)).body as {
        classOffering: { rosterMemberships: unknown[] };
      };
      expect(classOffering.rosterMemberships.length).toBeGreaterThanOrEqual(3);
    }
  });

  // The nightly reset runs whatever the date, so whatever the date the demo
  // has a Term running: either side of the year's turn, at either end of it,
  // and on a leap day.
  it.each(["2026-12-31", "2027-01-01", "2027-07-31", "2027-08-01", "2028-02-29"])(
    "has a Term running when seeded on %s",
    async (today) => {
      await seed(server(), today);

      const { rows } = await server().ownerDatabase.query(
        `SELECT
           (SELECT count(*)::int FROM app.academic_year WHERE $1::date BETWEEN first_date AND last_date) AS years,
           (SELECT count(*)::int FROM app.term WHERE $1::date BETWEEN first_date AND last_date) AS terms,
           (SELECT count(*)::int FROM app.instructional_day_exception e
              JOIN app.academic_year y ON y.id = e.academic_year_id
             WHERE e.date NOT BETWEEN y.first_date AND y.last_date OR extract(isodow FROM e.date) > 5) AS misplaced`,
        [today],
      );

      expect(rows[0]).toEqual({ years: 1, terms: 1, misplaced: 0 });
    },
  );

  it("writes no Audit record, since no one in the School did anything", async () => {
    await seed(server());

    const { rows } = await server().ownerDatabase.query("SELECT count(*)::int AS count FROM app.audit_record");

    expect(rows[0].count).toBe(0);
  });

  it("refuses to run twice rather than seeding a second copy", async () => {
    await seed(server());

    await expect(seed(server())).rejects.toThrow(/duplicate key/);
  });
});
