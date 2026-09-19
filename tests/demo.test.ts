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

const SEED = new URL("../demo/seed.sql", import.meta.url);

/** Runs the seed as the maintainer does: as the schema owner, against a freshly migrated database. */
async function seed(server: TestServer): Promise<void> {
  await server.ownerDatabase.query(await readFile(SEED, "utf8"));
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

    expect(await personsSeenBy(clients.school_administrator, schoolId)).toEqual([
      "Alex Lindqvist",
      "Jamie Lindqvist",
      "Morgan Reyes",
      "Sam Achterberg",
    ]);
    expect(await personsSeenBy(clients.faculty, schoolId)).toEqual(["Sam Achterberg"]);
    expect(await personsSeenBy(clients.student, schoolId)).toEqual(["Jamie Lindqvist"]);
    // The Guardian reaches the Student they are linked to, and no one else.
    expect(await personsSeenBy(clients.guardian, schoolId)).toEqual(["Alex Lindqvist", "Jamie Lindqvist"]);

    expect((await clients.school_administrator.inSchool(schoolId).get("/audit-records")).status).toBe(200);
    for (const role of ["faculty", "student", "guardian"] as const) {
      expect((await clients[role].inSchool(schoolId).get("/audit-records")).status).toBe(404);
    }
  });

  it("enrolls the Student, and links the Guardian to them with a full Access profile", async () => {
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

    expect(enrollments.enrollments).toEqual([
      expect.objectContaining({ studentPersonId: idOf("Jamie Lindqvist"), endedAt: null }),
    ]);
    expect(links.guardianLinks).toEqual([
      expect.objectContaining({
        guardianPersonId: idOf("Alex Lindqvist"),
        studentPersonId: idOf("Jamie Lindqvist"),
        accessProfile: { attendanceRead: true, resultsRead: true },
        endedAt: null,
      }),
    ]);
  });

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
