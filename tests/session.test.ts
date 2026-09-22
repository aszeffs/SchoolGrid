import { describe, expect, it } from "vitest";
import { observable, useTestServer } from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const BOB = { username: "bob", password: "yet another staple, longer" };
const PAT = { username: "pat", password: "the platform's own staple" };

/**
 * What `GET /api/session` says about whoever holds the Session: the account,
 * and the Schools, Persons and roles that are the actor's own facts. Never a
 * permission, and never a fact about anyone else (ADR-0007).
 */
describe("the session names the actor", () => {
  const server = useTestServer();

  it("names the account, and in each School it reaches the Person and the roles they hold", async () => {
    const alice = await server().createAccount(ALICE);
    const { school, schoolAdministrator } = await server().provisionSchool({
      name: "Northside",
      administrator: alice,
    });
    await server().grantMembership({ person: schoolAdministrator, role: "faculty" });

    const caller = await server().signIn(ALICE);
    const response = await caller.get("/api/session");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      account: { id: alice.id, username: "alice" },
      schools: [
        {
          schoolId: school.id,
          name: "Northside",
          personId: schoolAdministrator.id,
          displayName: schoolAdministrator.displayName,
          roles: ["school_administrator", "faculty"],
        },
      ],
    });
  });

  it("names only the caller: no other Person, and no role held by one", async () => {
    const alice = await server().createAccount(ALICE);
    const bob = await server().createAccount(BOB);
    const { school } = await server().provisionSchool({ name: "Northside", administrator: alice });
    const bobsPerson = await server().createPerson({
      schoolId: school.id,
      displayName: "Bob Faculty",
      account: bob,
      role: "faculty",
    });
    await server().createPerson({ schoolId: school.id, displayName: "Stella Student", role: "student" });

    const caller = await server().signIn(BOB);
    const response = await caller.get("/api/session");

    // Exactly Bob's own Person and role: the School Administrator sharing the
    // School, and the Student who has no account at all, are simply not in it.
    expect(response.body).toEqual({
      account: { id: bob.id, username: "bob" },
      schools: [
        {
          schoolId: school.id,
          name: "Northside",
          personId: bobsPerson.id,
          displayName: "Bob Faculty",
          roles: ["faculty"],
        },
      ],
    });
  });

  it("gives an account that reaches no School an empty list, not a refusal", async () => {
    const account = await server().createAccount(ALICE);

    const caller = await server().signIn(ALICE);
    const response = await caller.get("/api/session");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ account: { id: account.id, username: "alice" }, schools: [] });
  });

  // A Platform Administrator operates the platform and reaches no School's
  // records, so the session names their account and nothing more.
  it("gives a Platform Administrator an empty list", async () => {
    const account = await server().createAccount(PAT);
    await server().createPlatformAdministrator({ account });

    const caller = await server().signIn(PAT);
    const response = await caller.get("/api/session");

    expect(response.body).toEqual({ account: { id: account.id, username: "pat" }, schools: [] });
  });

  // A Person whose memberships have all ended reaches nothing, exactly as
  // `GET /api/schools` already says: all access flows from a membership held
  // at this moment.
  it("leaves out a School where every membership the Person holds has ended", async () => {
    const alice = await server().createAccount(ALICE);
    const { school } = await server().provisionSchool({ name: "Northside", administrator: alice });
    const bob = await server().createAccount(BOB);
    const person = await server().createPerson({ schoolId: school.id, displayName: "Bob Faculty", account: bob });
    await server().grantMembership({
      person,
      role: "faculty",
      startsAt: new Date("2020-01-01T00:00:00Z"),
      endsAt: new Date("2021-01-01T00:00:00Z"),
    });

    const caller = await server().signIn(BOB);
    const response = await caller.get("/api/session");

    expect(response.body).toEqual({ account: { id: bob.id, username: "bob" }, schools: [] });
  });

  // ADR-0001: no record is shared between Schools, so each School names the
  // Person the account resolves to there and that Person's roles alone.
  it("names every School an account reaches, keeping each School's records to itself", async () => {
    const alice = await server().createAccount(ALICE);
    const bob = await server().createAccount(BOB);
    const northside = await server().provisionSchool({ name: "Northside", administrator: alice });
    const westbrook = await server().provisionSchool({ name: "Westbrook", administrator: bob });
    const aliceAtWestbrook = await server().createPerson({
      schoolId: westbrook.school.id,
      displayName: "Alice Guardian",
      account: alice,
      role: "guardian",
    });

    const caller = await server().signIn(ALICE);
    const response = await caller.get("/api/session");

    expect(response.body).toEqual({
      account: { id: alice.id, username: "alice" },
      schools: [
        {
          schoolId: northside.school.id,
          name: "Northside",
          personId: northside.schoolAdministrator.id,
          displayName: northside.schoolAdministrator.displayName,
          roles: ["school_administrator"],
        },
        {
          schoolId: westbrook.school.id,
          name: "Westbrook",
          personId: aliceAtWestbrook.id,
          displayName: "Alice Guardian",
          roles: ["guardian"],
        },
      ],
    });
  });

  it("is refused without a live Session, exactly as a route that does not exist", async () => {
    await server().createAccount(ALICE);
    const caller = await server().signIn(ALICE);
    await caller.delete("/api/session");

    const ended = await caller.get("/api/session");
    const anonymous = await server().client.get("/api/session");
    const nonexistent = await server().client.get("/api/no-such-route");

    expect(observable(ended)).toEqual(observable(nonexistent));
    expect(observable(anonymous)).toEqual(observable(nonexistent));
  });

  /**
   * ADR-0007: the response carries facts, never a decision. A capability the
   * web app could read would be a second copy of the authorization rules,
   * free to drift from the one the server enforces.
   */
  it("carries no permission flag and no capability boolean", async () => {
    const alice = await server().createAccount(ALICE);
    const { school } = await server().provisionSchool({ name: "Northside", administrator: alice });

    const caller = await server().signIn(ALICE);
    const response = await caller.get("/api/session");

    const body = response.body as { schools: Record<string, unknown>[] };
    expect(Object.keys(response.body as object).sort()).toEqual(["account", "schools"]);
    expect(Object.keys(body.schools[0]!).sort()).toEqual([
      "displayName",
      "name",
      "personId",
      "roles",
      "schoolId",
    ]);
    expect(Object.values(body.schools[0]!).some((value) => typeof value === "boolean")).toBe(false);
    expect(body.schools[0]!["schoolId"]).toBe(school.id);
  });
});
