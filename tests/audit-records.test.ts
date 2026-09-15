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
        (w: World) => w.alice.inSchool(w.westbrookId).get("/audit-records"),
      ],
      [
        "a School Administrator reading a School where they administer nothing",
        (w: World) => w.alice.inSchool(w.eastfieldId).get("/audit-records"),
      ],
      [
        "a Person without the School Administrator role",
        (w: World) => w.sam.inSchool(w.northsideId).get("/audit-records"),
      ],
      [
        "a caller with no session",
        (w: World) => server().client.inSchool(w.northsideId).get("/audit-records"),
      ],
      [
        "a School that does not exist",
        (w: World) => w.alice.inSchool(ABSENT_ID).get("/audit-records"),
      ],
    ])("refuses %s exactly as an absent Person is refused", async (_case, attempt) => {
      const world = await arrange();

      const absent = await world.alice.inSchool(world.northsideId).get(`/persons/${ABSENT_ID}`);
      const refused = await attempt(world);

      expect(absent.status).not.toBe(200);
      expect(observable(refused)).toEqual(observable(absent));
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
