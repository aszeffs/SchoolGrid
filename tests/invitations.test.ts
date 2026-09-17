import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { UserAccount } from "../src/authentication/index.ts";
import { observable, useTestServer, type TestClient, type TestResponse } from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const ANNE = { username: "anne", password: "a second administrator's staple" };
const BOB = { username: "bob", password: "yet another staple, longer" };
const SAM = { username: "sam", password: "a different staple entirely" };
const GINA = { username: "gina", password: "a guardian's staple, twice over" };
const FRAN = { username: "fran", password: "a faculty staple, well chosen" };
const PAT = { username: "pat", password: "the platform's own staple" };
const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

const DAY_MS = 24 * 60 * 60 * 1000;

interface Invitation {
  id: string;
  person: { id: string; displayName: string };
  issuedAt: string;
  expiresAt: string;
}

interface Issued {
  invitation: Invitation;
  link: string;
}

interface AuditRecord {
  actorPersonId: string | null;
  action: string;
  target: { type: string; id: string | null };
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/** The secret a link carries, after the `#` that keeps it out of every request. */
function secretOf(link: string): string {
  return new URL(link).hash.slice(1);
}

describe("Invitations", () => {
  const server = useTestServer();

  interface World {
    northsideId: string;
    westbrookId: string;
    aliceId: string;
    /** Alice and Anne: Northside's two School Administrators. */
    alice: TestClient;
    anne: TestClient;
    anneId: string;
    /** Sam, Gina, and Fran: a Student, a Guardian, and Faculty at Northside, who can sign in. */
    sam: TestClient;
    gina: TestClient;
    fran: TestClient;
    samAccount: UserAccount;
    /** Bob: Westbrook's School Administrator, with no Person at Northside. */
    bob: TestClient;
    /** Pat: a Platform Administrator, whose account also resolves to a Northside School Administrator. */
    pat: TestClient;
    /** Riley and Casey: unclaimed Persons at Northside. */
    rileyId: string;
    caseyId: string;
    /** Wren: an unclaimed Person at Westbrook. */
    wrenId: string;
  }

  async function arrange(): Promise<World> {
    const alice = await server().createAccount(ALICE);
    const bob = await server().createAccount(BOB);
    const northside = await server().provisionSchool({ name: "Northside", administrator: alice });
    const westbrook = await server().provisionSchool({ name: "Westbrook", administrator: bob });
    const schoolId = northside.school.id;
    const anne = await server().createPerson({
      schoolId,
      displayName: "Anne",
      account: await server().createAccount(ANNE),
      role: "school_administrator",
    });
    const samAccount = await server().createAccount(SAM);
    const sam = await server().createPerson({ schoolId, displayName: "Sam", account: samAccount, role: "student" });
    await server().enroll(sam);
    for (const [displayName, credentials, role] of [
      ["Gina", GINA, "guardian"],
      ["Fran", FRAN, "faculty"],
    ] as const) {
      await server().createPerson({
        schoolId,
        displayName,
        account: await server().createAccount(credentials),
        role,
      });
    }
    const patAccount = await server().createAccount(PAT);
    await server().createPlatformAdministrator({ account: patAccount });
    await server().createPerson({ schoolId, displayName: "Pat", account: patAccount, role: "school_administrator" });
    const riley = await server().createPerson({ schoolId, displayName: "Riley" });
    const casey = await server().createPerson({ schoolId, displayName: "Casey" });
    const wren = await server().createPerson({ schoolId: westbrook.school.id, displayName: "Wren" });
    const inNorthside = async (credentials: typeof ALICE) => (await server().signIn(credentials)).inSchool(schoolId);
    return {
      northsideId: schoolId,
      westbrookId: westbrook.school.id,
      aliceId: northside.schoolAdministrator.id,
      alice: await inNorthside(ALICE),
      anne: await inNorthside(ANNE),
      anneId: anne.id,
      sam: await inNorthside(SAM),
      gina: await inNorthside(GINA),
      fran: await inNorthside(FRAN),
      samAccount,
      bob: await inNorthside(BOB),
      pat: await inNorthside(PAT),
      rileyId: riley.id,
      caseyId: casey.id,
      wrenId: wren.id,
    };
  }

  const issue = async (client: TestClient, personId: string) => {
    const response = await client.post("/invitations", { personId });
    expect(response.status).toBe(201);
    return response.body as Issued;
  };

  const pending = async (world: World) =>
    ((await world.alice.get("/invitations")).body as { invitations: Invitation[] }).invitations;

  const trail = async (world: World) =>
    ((await world.alice.get("/audit-records")).body as { auditRecords: AuditRecord[] }).auditRecords;

  /** The refusal every failed request gets: here, for reading a Person that does not exist. */
  const standardRefusal = (world: World) => world.sam.get(`/persons/${ABSENT_ID}`);

  describe("issuing", () => {
    it("gives a School Administrator a redemption link for an unclaimed Person, expiring in 7 days", async () => {
      const world = await arrange();

      const issued = await world.alice.post("/invitations", { personId: world.rileyId });

      expect(issued.status).toBe(201);
      expect(issued.body).toEqual({
        invitation: {
          id: expect.any(String),
          person: { id: world.rileyId, displayName: "Riley" },
          issuedAt: expect.any(String),
          expiresAt: expect.any(String),
        },
        link: expect.stringMatching(`^${server().publicOrigin}/invitation#[A-Za-z0-9_-]{43}$`),
      });
      const { invitation } = issued.body as Issued;
      expect(Date.parse(invitation.expiresAt) - Date.parse(invitation.issuedAt)).toBe(7 * DAY_MS);
    });

    it("gives every Invitation its own secret", async () => {
      const world = await arrange();

      const riley = await issue(world.alice, world.rileyId);
      const casey = await issue(world.alice, world.caseyId);

      expect(secretOf(riley.link)).not.toEqual(secretOf(casey.link));
    });

    it("lists the Invitation as pending, with its Person and expiry", async () => {
      const world = await arrange();

      const { invitation } = await issue(world.alice, world.rileyId);

      expect(await pending(world)).toEqual([invitation]);
    });

    it("never again serves the secret, in any response", async () => {
      const world = await arrange();
      const { invitation, link } = await issue(world.alice, world.rileyId);
      const secret = secretOf(link);

      const later: TestResponse[] = [
        await world.alice.get("/invitations"),
        await world.alice.get("/persons"),
        await world.alice.get(`/persons/${world.rileyId}`),
        await world.alice.get("/audit-records"),
        await world.anne.get("/invitations"),
        await world.alice.delete(`/invitations/${invitation.id}`),
        await world.alice.get("/audit-records"),
      ];

      expect(later.map(({ status }) => status)).toEqual([200, 200, 200, 200, 200, 200, 200]);
      for (const response of later) {
        expect(response.raw).not.toContain(secret);
        expect(response.raw).not.toContain("secret");
      }
    });

    it("stores only the secret's hash", async () => {
      const world = await arrange();
      const { invitation, link } = await issue(world.alice, world.rileyId);
      const secret = secretOf(link);
      const secretBytes = Buffer.from(secret, "base64url");

      // That no readable secret is stored is a database guarantee no caller can
      // observe, so the table is read directly.
      const { rows } = await server().ownerDatabase.query<{ row: string; secret_hash: Buffer }>(
        `SELECT row_to_json(invitation)::text AS row, secret_hash FROM app.invitation invitation WHERE id = $1`,
        [invitation.id],
      );

      expect(rows).toHaveLength(1);
      const { row, secret_hash } = rows[0]!;
      expect(secret_hash).toEqual(createHash("sha256").update(secret).digest());
      for (const encoding of [secret, secretBytes.toString("hex"), secretBytes.toString("base64")]) {
        expect(row).not.toContain(encoding);
      }
    });

    it("records the issuing in the School's Audit records, without the secret or a display name", async () => {
      const world = await arrange();

      const { invitation, link } = await issue(world.alice, world.rileyId);

      const [record] = await trail(world);
      expect(record).toEqual({
        id: expect.any(String),
        occurredAt: expect.any(String),
        actorPersonId: world.aliceId,
        actorPlatformAdministratorId: null,
        action: "invitation.issued",
        target: { type: "invitation", id: invitation.id },
        reason: null,
        before: null,
        after: { personId: world.rileyId, expiresAt: invitation.expiresAt, revokedAt: null },
      });
      expect(JSON.stringify(record)).not.toContain(secretOf(link));
    });

    describe("a second Invitation for the same Person", () => {
      it("revokes the first, leaving only the second pending", async () => {
        const world = await arrange();
        const first = await issue(world.alice, world.rileyId);

        const second = await issue(world.anne, world.rileyId);

        expect(await pending(world)).toEqual([second.invitation]);
        const revokingFirst = await world.alice.delete(`/invitations/${first.invitation.id}`);
        expect(observable(revokingFirst)).toEqual(observable(await standardRefusal(world)));
      });

      it("records both the revocation and the issuing", async () => {
        const world = await arrange();
        const first = await issue(world.alice, world.rileyId);

        const second = await issue(world.anne, world.rileyId);

        const [issued, revoked] = await trail(world);
        expect(issued).toMatchObject({
          actorPersonId: world.anneId,
          action: "invitation.issued",
          target: { type: "invitation", id: second.invitation.id },
        });
        expect(revoked).toMatchObject({
          actorPersonId: world.anneId,
          action: "invitation.revoked",
          target: { type: "invitation", id: first.invitation.id },
          before: { personId: world.rileyId, expiresAt: first.invitation.expiresAt, revokedAt: null },
          after: {
            personId: world.rileyId,
            expiresAt: first.invitation.expiresAt,
            revokedAt: expect.any(String),
            supersededByInvitationId: second.invitation.id,
          },
        });
        // Revoked before the second was issued, so the two were never pending at once.
        const revokedAt = Date.parse((revoked!.after as { revokedAt: string }).revokedAt);
        expect(revokedAt).toBeLessThanOrEqual(Date.parse(second.invitation.issuedAt));
      });

      it("revokes nothing, and issues nothing, when the Audit record cannot be written", async () => {
        const world = await arrange();
        const first = await issue(world.alice, world.rileyId);
        // Rolling back with the audit write is a database guarantee no caller
        // can observe, so the table is read directly.
        const invitations = async () =>
          (await server().ownerDatabase.query("SELECT * FROM app.invitation ORDER BY id")).rows;
        const before = await invitations();
        await server().ownerDatabase.query("REVOKE INSERT ON app.audit_record FROM schoolgrid_app");

        const attempted = await world.alice.post("/invitations", { personId: world.rileyId });

        expect(attempted.status).toBe(500);
        expect(await invitations()).toEqual(before);
        await server().ownerDatabase.query("GRANT INSERT ON app.audit_record TO schoolgrid_app");
        expect(await pending(world)).toEqual([first.invitation]);
      });

      it("leaves exactly one pending when two are issued at once", async () => {
        const world = await arrange();

        const issued = await Promise.all([
          world.alice.post("/invitations", { personId: world.rileyId }),
          world.anne.post("/invitations", { personId: world.rileyId }),
        ]);

        expect(issued.map(({ status }) => status)).toEqual([201, 201]);
        expect(await pending(world)).toHaveLength(1);
      });
    });

    it("issues a fresh Invitation once the last has expired, revoking nothing", async () => {
      const world = await arrange();
      const lapsed = await issue(world.alice, world.rileyId);
      await server().expireInvitation(lapsed.invitation.id);
      expect(await pending(world)).toEqual([]);

      const fresh = await issue(world.alice, world.rileyId);

      expect(await pending(world)).toEqual([fresh.invitation]);
      expect((await trail(world)).map(({ action }) => action)).not.toContain("invitation.revoked");
    });

    describe("a malformed request", () => {
      it.each([
        ["no Person", {}],
        ["a Person that is not text", { personId: 7 }],
        ["an empty Person", { personId: "" }],
        ["a field besides the Person", { personId: ABSENT_ID, expiresAt: "2099-01-01T00:00:00Z" }],
        ["a body that is not an object", [ABSENT_ID]],
      ])("rejects %s, issuing nothing", async (_case, body) => {
        const world = await arrange();

        const rejected = await world.alice.post("/invitations", body);

        expect(rejected.status).toBe(400);
        expect(rejected.body).toEqual({ status: "invalid_request" });
        expect(await pending(world)).toEqual([]);
      });
    });

    describe("for a Person who cannot be invited", () => {
      it.each([
        ["a claimed Person", (w: World) => w.aliceId],
        ["a Person in another School", (w: World) => w.wrenId],
        ["an unknown Person", () => ABSENT_ID],
        ["an identifier that could name no Person", () => "not-a-person"],
      ])("refuses %s exactly as an absent Person is refused, issuing nothing", async (_case, personId) => {
        const world = await arrange();

        const refused = await world.alice.post("/invitations", { personId: personId(world) });

        expect(observable(refused)).toEqual(observable(await standardRefusal(world)));
        expect(await pending(world)).toEqual([]);
      });

      it("records each refusal with its true reason", async () => {
        const world = await arrange();

        await world.alice.post("/invitations", { personId: world.aliceId });
        await world.alice.post("/invitations", { personId: world.wrenId });
        await world.alice.post("/invitations", { personId: ABSENT_ID });

        const refusals = (await trail(world)).filter(({ action }) => action === "access.refused");
        expect(refusals.map(({ reason, target }) => [reason, target])).toEqual([
          ["absent", { type: "person", id: ABSENT_ID }],
          ["outside-school", { type: "person", id: world.wrenId }],
          ["claimed", { type: "person", id: world.aliceId }],
        ]);
      });
    });
  });

  describe("revoking", () => {
    it("ends a pending Invitation, which is then no longer listed", async () => {
      const world = await arrange();
      const riley = await issue(world.alice, world.rileyId);
      const casey = await issue(world.alice, world.caseyId);

      const revoked = await world.alice.delete(`/invitations/${riley.invitation.id}`);

      expect(revoked.status).toBe(200);
      expect(revoked.body).toEqual({ invitation: { ...riley.invitation, revokedAt: expect.any(String) } });
      expect(await pending(world)).toEqual([casey.invitation]);
    });

    it("lets any School Administrator revoke an Invitation a colleague issued", async () => {
      const world = await arrange();
      const { invitation } = await issue(world.alice, world.rileyId);

      const revoked = await world.anne.delete(`/invitations/${invitation.id}`);

      expect(revoked.status).toBe(200);
      expect(await pending(world)).toEqual([]);
    });

    it("records the revocation, with the reason given", async () => {
      const world = await arrange();
      const { invitation } = await issue(world.alice, world.rileyId);

      const revoked = await world.anne.delete(`/invitations/${invitation.id}`, { reason: "handed to the wrong Person" });

      const { revokedAt } = (revoked.body as { invitation: { revokedAt: string } }).invitation;
      const [record] = await trail(world);
      expect(record).toEqual({
        id: expect.any(String),
        occurredAt: expect.any(String),
        actorPersonId: world.anneId,
        actorPlatformAdministratorId: null,
        action: "invitation.revoked",
        target: { type: "invitation", id: invitation.id },
        reason: "handed to the wrong Person",
        before: { personId: world.rileyId, expiresAt: invitation.expiresAt, revokedAt: null },
        after: { personId: world.rileyId, expiresAt: invitation.expiresAt, revokedAt },
      });
    });

    it("revokes nothing when the Audit record cannot be written", async () => {
      const world = await arrange();
      const { invitation } = await issue(world.alice, world.rileyId);
      await server().ownerDatabase.query("REVOKE INSERT ON app.audit_record FROM schoolgrid_app");

      const attempted = await world.alice.delete(`/invitations/${invitation.id}`);

      expect(attempted.status).toBe(500);
      await server().ownerDatabase.query("GRANT INSERT ON app.audit_record TO schoolgrid_app");
      expect(await pending(world)).toEqual([invitation]);
    });

    it("rejects a malformed reason, revoking nothing", async () => {
      const world = await arrange();
      const { invitation } = await issue(world.alice, world.rileyId);

      const rejected = await world.alice.delete(`/invitations/${invitation.id}`, { reason: 7 });

      expect(rejected.status).toBe(400);
      expect(await pending(world)).toEqual([invitation]);
    });

    describe("an Invitation that is not pending", () => {
      const cases: [string, (world: World, invitationId: string) => Promise<unknown>, string][] = [
        ["already revoked", (w, id) => w.alice.delete(`/invitations/${id}`), "revoked"],
        ["redeemed", (w, id) => server().markInvitationRedeemed(id, w.samAccount), "redeemed"],
        ["expired", (_w, id) => server().expireInvitation(id), "expired"],
      ];

      it.each(cases)("refuses revoking one %s exactly as an absent one, recording why", async (_case, end, reason) => {
        const world = await arrange();
        const { invitation } = await issue(world.alice, world.rileyId);
        await end(world, invitation.id);

        const refused = await world.alice.delete(`/invitations/${invitation.id}`);
        const absent = await world.alice.delete(`/invitations/${ABSENT_ID}`);

        expect(observable(refused)).toEqual(observable(await standardRefusal(world)));
        expect(observable(absent)).toEqual(observable(refused));
        expect(await trail(world)).toContainEqual(
          expect.objectContaining({
            action: "access.refused",
            reason,
            target: { type: "invitation", id: invitation.id },
          }),
        );
      });
    });

    it("refuses revoking another School's Invitation exactly as an absent one", async () => {
      const world = await arrange();
      const westbrook = (await server().signIn(BOB)).inSchool(world.westbrookId);
      const { invitation } = await issue(westbrook, world.wrenId);

      const refused = await world.alice.delete(`/invitations/${invitation.id}`);

      expect(observable(refused)).toEqual(observable(await standardRefusal(world)));
      expect((await westbrook.get("/invitations")).body).toEqual({ invitations: [invitation] });
      expect(await trail(world)).toContainEqual(
        expect.objectContaining({
          action: "access.refused",
          reason: "outside-school",
          target: { type: "invitation", id: invitation.id },
        }),
      );
    });
  });

  describe("every caller but a School Administrator of the School is refused", () => {
    const callers: [string, (world: World) => TestClient][] = [
      ["Faculty", (w) => w.fran],
      ["a Student", (w) => w.sam],
      ["a Guardian", (w) => w.gina],
      ["a School Administrator of another School", (w) => w.bob],
      ["a Platform Administrator", (w) => w.pat],
      ["a caller with no session", (w) => server().client.inSchool(w.northsideId)],
    ];

    it.each(callers)("refuses %s issuing, listing, or revoking, whatever the body, changing nothing", async (_case, caller) => {
      const world = await arrange();
      const { invitation } = await issue(world.alice, world.caseyId);
      const refusal = observable(await standardRefusal(world));

      const attempts = [
        await caller(world).post("/invitations", { personId: world.rileyId }),
        await caller(world).post("/invitations", { personId: 7 }),
        await caller(world).get("/invitations"),
        await caller(world).delete(`/invitations/${invitation.id}`),
        await caller(world).delete(`/invitations/${invitation.id}`, { reason: 7 }),
      ];

      for (const attempt of attempts) {
        expect(observable(attempt)).toEqual(refusal);
      }
      expect(await pending(world)).toEqual([invitation]);
    });
  });
});
