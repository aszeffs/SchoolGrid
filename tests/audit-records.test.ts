import { describe, expect, it } from "vitest";
import { assertLeastPrivilege } from "../src/db/runtime-role.ts";
import { observable, useTestServer, type TestClient } from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const BOB = { username: "bob", password: "yet another staple, longer" };
const SAM = { username: "sam", password: "a different staple entirely" };
const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("Audit records", () => {
  const server = useTestServer();

  it("lets a School Administrator read their own School's trail, and only it", async () => {
    const alice = await server().createAccount(ALICE);
    const bob = await server().createAccount(BOB);
    const northside = await server().provisionSchool({ name: "Northside", administrator: alice });
    await server().provisionSchool({ name: "Westbrook", administrator: bob });
    const sam = await server().createPerson({ schoolId: northside.school.id, displayName: "Sam" });
    await server().appendAuditRecord({
      schoolId: northside.school.id,
      actorPersonId: northside.schoolAdministrator.id,
      action: "membership.granted",
      target: { type: "person", id: sam.id },
      reason: "Joined the faculty",
      before: { role: null },
      after: { role: "faculty" },
    });

    const caller = (await server().signIn(ALICE)).inSchool(northside.school.id);
    const response = await caller.get("/audit-records");

    expect(response.status).toBe(200);
    // Newest first. Westbrook's provisioning is not here.
    expect(response.body).toEqual({
      auditRecords: [
        {
          id: expect.any(String),
          occurredAt: expect.stringMatching(ISO_TIMESTAMP),
          actorPersonId: northside.schoolAdministrator.id,
          actorPlatformAdministratorId: null,
          action: "authentication.succeeded",
          target: { type: "person", id: northside.schoolAdministrator.id },
          reason: null,
          before: null,
          after: null,
        },
        {
          id: expect.any(String),
          occurredAt: expect.stringMatching(ISO_TIMESTAMP),
          actorPersonId: northside.schoolAdministrator.id,
          actorPlatformAdministratorId: null,
          action: "membership.granted",
          target: { type: "person", id: sam.id },
          reason: "Joined the faculty",
          before: { role: null },
          after: { role: "faculty" },
        },
        {
          id: expect.any(String),
          occurredAt: expect.stringMatching(ISO_TIMESTAMP),
          actorPersonId: null,
          actorPlatformAdministratorId: null,
          action: "school.provisioned",
          target: { type: "school", id: northside.school.id },
          reason: null,
          before: null,
          after: {
            name: "Northside",
            schoolAdministratorPersonId: northside.schoolAdministrator.id,
          },
        },
      ],
      // All of it fitted on one page, so there is no next one.
      nextCursor: null,
    });
  });

  describe("are read a page at a time (ADR-0008)", () => {
    interface Page {
      auditRecords: { id: string; action: string }[];
      nextCursor: string | null;
    }

    /**
     * Alice administers Northside, whose trail holds her sign-in, its
     * provisioning, and `count` more records appended one at a time, oldest
     * first, as `step.1` onwards.
     */
    async function arrange(count: number) {
      const alice = await server().createAccount(ALICE);
      const { school, schoolAdministrator } = await server().provisionSchool({ name: "Northside", administrator: alice });
      const caller = (await server().signIn(ALICE)).inSchool(school.id);
      const append = async (action: string) =>
        server().appendAuditRecord({
          schoolId: school.id,
          actorPersonId: schoolAdministrator.id,
          action,
          target: { type: "school", id: school.id },
          reason: null,
          before: null,
          after: null,
        });
      for (let step = 1; step <= count; step++) {
        await append(`step.${step}`);
      }
      return { caller, schoolId: school.id, append };
    }

    const read = async (caller: TestClient, query: string): Promise<Page> => {
      const response = await caller.get(`/audit-records${query}`);
      expect(response.status).toBe(200);
      return response.body as Page;
    };

    /** Every page from the first, following each cursor until there is none. */
    async function readAll(caller: TestClient, limit: number): Promise<Page[]> {
      const pages = [await read(caller, `?limit=${limit}`)];
      while (pages.at(-1)!.nextCursor !== null) {
        pages.push(await read(caller, `?limit=${limit}&cursor=${encodeURIComponent(pages.at(-1)!.nextCursor!)}`));
      }
      return pages;
    }

    const actions = (pages: Page[]) => pages.flatMap((page) => page.auditRecords.map((record) => record.action));

    it("pages newest first, each record once, and says when there is no next page", async () => {
      const { caller } = await arrange(3);

      const pages = await readAll(caller, 2);

      expect(pages.map((page) => page.auditRecords.length)).toEqual([2, 2, 1]);
      expect(actions(pages)).toEqual([
        "step.3",
        "step.2",
        "step.1",
        "authentication.succeeded",
        "school.provisioned",
      ]);
      expect(pages.at(-1)!.nextCursor).toBeNull();
    });

    it("neither skips nor repeats a record when new ones are written while paging", async () => {
      const { caller, append } = await arrange(4);
      const first = await read(caller, "?limit=3");

      await append("written.meanwhile.1");
      await append("written.meanwhile.2");
      const rest = [await read(caller, `?limit=3&cursor=${encodeURIComponent(first.nextCursor!)}`)];
      while (rest.at(-1)!.nextCursor !== null) {
        rest.push(await read(caller, `?limit=3&cursor=${encodeURIComponent(rest.at(-1)!.nextCursor!)}`));
      }

      // What was written behind the cursor is on a first page read afresh, not here.
      expect(actions([first, ...rest])).toEqual([
        "step.4",
        "step.3",
        "step.2",
        "step.1",
        "authentication.succeeded",
        "school.provisioned",
      ]);
      expect(actions([await read(caller, "?limit=2")])).toEqual(["written.meanwhile.2", "written.meanwhile.1"]);
    });

    it("reads fifty records to a page unless asked for fewer, and never more than a hundred", async () => {
      const { caller, schoolId } = await arrange(0);
      await server().database.query(
        `INSERT INTO app.audit_record (school_id, action, target_type)
         SELECT $1, 'bulk.' || step, 'school' FROM generate_series(1, 150) AS step`,
        [schoolId],
      );

      expect((await read(caller, "")).auditRecords).toHaveLength(50);
      expect((await read(caller, "?limit=100")).auditRecords).toHaveLength(100);
      expect((await read(caller, "?limit=1")).auditRecords).toHaveLength(1);
    });

    it.each([
      ["a cursor that is not an identifier", () => "?cursor=not-a-cursor"],
      ["an empty cursor", () => "?cursor="],
      ["a cursor naming no Audit record", () => `?cursor=${ABSENT_ID}`],
      ["two cursors", (cursor: string) => `?cursor=${cursor}&cursor=${cursor}`],
      ["a page size of none", () => "?limit=0"],
      ["a page size above a hundred", () => "?limit=101"],
      ["a page size that is not a whole number", () => "?limit=1.5"],
      ["a page size that is not a number", () => "?limit=ten"],
      ["two page sizes", () => "?limit=1&limit=2"],
    ])("rejects %s as malformed", async (_case, query) => {
      const { caller } = await arrange(2);
      const { nextCursor } = await read(caller, "?limit=1");

      const response = await caller.get(`/audit-records${query(nextCursor!)}`);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ status: "invalid_request" });
    });

    // A cursor names a record in the caller's own trail, or it is malformed. A
    // cursor from another School's trail is refused the way one naming nothing
    // is, so it cannot be used to learn that the record exists.
    it("rejects a cursor from another School's trail exactly as one naming no record", async () => {
      const { caller } = await arrange(0);
      const bob = await server().createAccount(BOB);
      const westbrook = await server().provisionSchool({ name: "Westbrook", administrator: bob });
      const [foreign] = (await read((await server().signIn(BOB)).inSchool(westbrook.school.id), "")).auditRecords;

      const fromElsewhere = await caller.get(`/audit-records?cursor=${foreign!.id}`);
      const namingNothing = await caller.get(`/audit-records?cursor=${ABSENT_ID}`);

      expect(fromElsewhere.status).toBe(400);
      expect(observable(fromElsewhere)).toEqual(observable(namingNothing));
    });
  });

  describe("reading another School's trail is the same refusal as any other", () => {
    interface World {
      alice: TestClient;
      sam: TestClient;
      northsideId: string;
      westbrookId: string;
      eastfieldId: string;
    }

    /**
     * Alice administers Northside, is Faculty at Eastfield, and has
     * nothing at Westbrook. Sam is a Student at Northside.
     */
    async function arrange(): Promise<World> {
      const alice = await server().createAccount(ALICE);
      const bob = await server().createAccount(BOB);
      const sam = await server().createAccount(SAM);
      const northside = await server().provisionSchool({ name: "Northside", administrator: alice });
      const westbrook = await server().provisionSchool({ name: "Westbrook", administrator: bob });
      const eastfield = await server().provisionSchool({ name: "Eastfield", administrator: bob });
      await server().createPerson({ schoolId: eastfield.school.id, displayName: "Alice", account: alice, role: "faculty" });
      await server().createPerson({ schoolId: northside.school.id, displayName: "Sam", account: sam, role: "student" });
      return {
        alice: await server().signIn(ALICE),
        sam: await server().signIn(SAM),
        northsideId: northside.school.id,
        westbrookId: westbrook.school.id,
        eastfieldId: eastfield.school.id,
      };
    }

    it.each([
      [
        "a School Administrator reading a School they have no Person in",
        (w: World, query: string) => w.alice.inSchool(w.westbrookId).get(`/audit-records${query}`),
      ],
      [
        "a School Administrator reading a School where they administer nothing",
        (w: World, query: string) => w.alice.inSchool(w.eastfieldId).get(`/audit-records${query}`),
      ],
      [
        "a Person without the School Administrator role",
        (w: World, query: string) => w.sam.inSchool(w.northsideId).get(`/audit-records${query}`),
      ],
      [
        "a caller with no session",
        (w: World, query: string) => server().client.inSchool(w.northsideId).get(`/audit-records${query}`),
      ],
      [
        "a School that does not exist",
        (w: World, query: string) => w.alice.inSchool(ABSENT_ID).get(`/audit-records${query}`),
      ],
    ])("refuses %s exactly as an absent Person is refused", async (_case, attempt) => {
      const world = await arrange();

      const absent = await world.alice.inSchool(world.northsideId).get(`/persons/${ABSENT_ID}`);
      expect(absent.status).not.toBe(200);

      // The paging parameters are the caller's own input, well formed or not,
      // and none of them may change the refusal: validated ahead of the Access
      // decision, a malformed one would answer differently (ADR-0008).
      for (const query of ["", "?limit=2", "?cursor=not-a-cursor", `?cursor=${ABSENT_ID}`, "?limit=0&limit=1"]) {
        const refused = await attempt(world, query);
        expect(observable(refused), query).toEqual(observable(absent));
      }
    });
  });

  describe("a sensitive change and its Audit record commit together or not at all", () => {
    it("rolls the change back when its Audit record cannot be written", async () => {
      const alice = await server().createAccount(ALICE);
      // The fault: the application loses the one privilege the audit write needs.
      await server().ownerDatabase.query(
        "REVOKE INSERT ON app.audit_record FROM schoolgrid_app",
      );

      await expect(
        server().provisionSchool({ name: "Northside", administrator: alice }),
      ).rejects.toThrow(/permission denied for table audit_record/);

      const { rows } = await server().ownerDatabase.query<{ schools: number; persons: number }>(
        `SELECT (SELECT count(*)::int FROM app.school) AS schools,
                (SELECT count(*)::int FROM app.person) AS persons`,
      );
      expect(rows).toEqual([{ schools: 0, persons: 0 }]);
    });

    it("does not let the application choose when a record occurred", async () => {
      const alice = await server().createAccount(ALICE);
      const { school } = await server().provisionSchool({ name: "Northside", administrator: alice });

      await expect(
        server().database.query(
          `INSERT INTO app.audit_record (school_id, action, target_type, occurred_at)
           VALUES ($1, 'backdated', 'school', '2000-01-01')`,
          [school.id],
        ),
      ).rejects.toThrow(/permission denied for table audit_record/);
    });
  });

  describe("hold no credentials and no data beyond what an entry needs", () => {
    it("names the School Administrator a provisioning created by identifier, not by name", async () => {
      const alice = await server().createAccount(ALICE);
      const { school } = await server().provisionSchool({ name: "Northside", administrator: alice });

      const caller = (await server().signIn(ALICE)).inSchool(school.id);
      const response = await caller.get("/audit-records");

      expect(response.body).toMatchObject({
        auditRecords: [{ action: "authentication.succeeded" }, { action: "school.provisioned" }],
      });
      expect(response.raw).not.toContain("alice");
      expect(response.raw).not.toContain(ALICE.password);
    });

    it.each([
      ["a password", { password: "hunter2" }],
      ["a password hash", { passwordHash: "scrypt$..." }],
      ["a session token", { sessionToken: "dGhpcyBpcyBpbnZlbnRlZA" }],
      ["a secret", { clientSecret: "shh" }],
    ])("refuses a value carrying %s", async (_case, value) => {
      const alice = await server().createAccount(ALICE);
      const { school } = await server().provisionSchool({ name: "Northside", administrator: alice });

      for (const side of ["before", "after"] as const) {
        await expect(
          server().appendAuditRecord({
            schoolId: school.id,
            actorPersonId: null,
            action: "account.changed",
            target: { type: "school", id: school.id },
            reason: null,
            before: null,
            after: null,
            [side]: value,
          }),
        ).rejects.toThrow(/violates check constraint/);
      }
    });

    it("refuses a value that nests data beneath a key", async () => {
      const alice = await server().createAccount(ALICE);
      const { school } = await server().provisionSchool({ name: "Northside", administrator: alice });

      await expect(
        server().database.query(
          `INSERT INTO app.audit_record (school_id, action, target_type, after_value)
           VALUES ($1, 'nested', 'school', '{"details": {"anything": "at all"}}')`,
          [school.id],
        ),
      ).rejects.toThrow(/violates check constraint/);
    });
  });

  // The one test that looks inside a module rather than through HTTP. Issue #6
  // makes the module's interface itself the requirement, and an interface is
  // not observable from where a caller stands.
  it("offers append and School-scoped read, and no way to update or delete", async () => {
    const audit = await import("../src/audit/index.ts");

    // Recording an attempt or a refusal is an append by another name.
    expect(Object.keys(audit).sort()).toEqual([
      "appendAuditRecord",
      "readAuditRecords",
      "recordAuthenticationAttempt",
      "recordRefusal",
    ]);
  });

  describe("are append-only, enforced by the database", () => {
    async function arrangeRecord(): Promise<void> {
      const alice = await server().createAccount(ALICE);
      await server().provisionSchool({ name: "Northside", administrator: alice });
    }

    it("refuses the application's role an update", async () => {
      await arrangeRecord();

      await expect(
        server().database.query("UPDATE app.audit_record SET reason = 'rewritten'"),
      ).rejects.toThrow(/permission denied for table audit_record/);
    });

    it("refuses the application's role a delete", async () => {
      await arrangeRecord();

      await expect(server().database.query("DELETE FROM app.audit_record")).rejects.toThrow(
        /permission denied for table audit_record/,
      );
    });

    it("refuses the application's role a truncate", async () => {
      await arrangeRecord();

      await expect(server().database.query("TRUNCATE app.audit_record")).rejects.toThrow(
        /permission denied for table audit_record/,
      );
    });

    // Grants bind nobody who owns the table or is a superuser, so the guarantee
    // above is only as good as this: the application is neither.
    it("runs the application as a role that neither owns the table nor bypasses grants", async () => {
      const { rows } = await server().database.query<{
        owns: boolean;
        superuser: boolean;
        bypassesRowSecurity: boolean;
      }>(
        `SELECT pg_has_role(current_user, tableowner, 'MEMBER') AS owns,
                rolsuper AS superuser,
                rolbypassrls AS "bypassesRowSecurity"
         FROM pg_tables, pg_roles
         WHERE schemaname = 'app' AND tablename = 'audit_record' AND rolname = current_user`,
      );

      expect(rows).toEqual([{ owns: false, superuser: false, bypassesRowSecurity: false }]);
    });

    // Pointing DATABASE_URL at the owner or a superuser would quietly void every
    // guarantee above, so the application refuses to start rather than run so.
    it("lets the application start as its own role", async () => {
      await expect(assertLeastPrivilege(server().database)).resolves.toBeUndefined();
    });

    it("refuses to let the application start as a role that could alter the trail", async () => {
      await expect(assertLeastPrivilege(server().ownerDatabase)).rejects.toThrow(
        /could update, delete, or truncate Audit records/,
      );
    });

    it("refuses even the table's owner an update, delete, or truncate", async () => {
      await arrangeRecord();
      const { ownerDatabase } = server();

      for (const statement of [
        "UPDATE app.audit_record SET reason = 'rewritten'",
        "DELETE FROM app.audit_record",
        "TRUNCATE app.audit_record",
      ]) {
        await expect(ownerDatabase.query(statement)).rejects.toThrow(/append-only/);
      }
    });
  });
});
