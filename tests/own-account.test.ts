import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { UserAccount } from "../src/authentication/index.ts";
import type { Person } from "../src/identity/index.ts";
import { observable, useTestServer, type TestClient } from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const BOB = { username: "bob", password: "yet another staple, longer" };
const FRANKIE = { username: "frankie", password: "a faculty staple, at length" };
const SAM = { username: "sam", password: "a different staple entirely" };
const GINA = { username: "gina", password: "a guardian's staple, twice over" };

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface AccessProfile {
  attendanceRead: boolean;
  resultsRead: boolean;
}

interface OwnAccount {
  enrollment: { startedAt: string; endedAt: string | null } | null;
  linkedStudents: { student: { id: string; displayName: string }; accessProfile: AccessProfile }[];
}

/**
 * What an actor is told about themselves beyond what the session already says.
 * The landing page every Faculty member, Student and Guardian opens on is
 * built from this and the session, and from nothing else.
 */
describe("Your account", () => {
  const server = useTestServer();

  interface World {
    northsideId: string;
    aliceAdmin: TestClient;
    /** Frankie: Faculty at Northside. */
    frankiePerson: Person;
    /** Sam: a Student at Northside, enrolled. */
    samPerson: Person;
    /** Gina: a Guardian at Northside, linked to Sam. */
    ginaPerson: Person;
    accounts: Record<"frankie" | "sam" | "gina", UserAccount>;
  }

  async function arrange(): Promise<World> {
    const alice = await server().createAccount(ALICE);
    const frankie = await server().createAccount(FRANKIE);
    const sam = await server().createAccount(SAM);
    const gina = await server().createAccount(GINA);
    const northside = await server().provisionSchool({ name: "Northside", administrator: alice });
    const aliceAdmin = (await server().sessionFor(alice)).inSchool(northside.school.id);
    const inSchool = (displayName: string, account: UserAccount, role: "faculty" | "student" | "guardian") =>
      server().createPerson({ schoolId: northside.school.id, displayName, account, role });
    return {
      northsideId: northside.school.id,
      aliceAdmin,
      frankiePerson: await inSchool("Frankie", frankie, "faculty"),
      samPerson: await inSchool("Sam", sam, "student"),
      ginaPerson: await inSchool("Gina", gina, "guardian"),
      accounts: { frankie, sam, gina },
    };
  }

  /** The account as the caller is told it, which every actor reaches for themselves. */
  async function accountOf(client: TestClient): Promise<OwnAccount> {
    const response = await client.get("/account");
    expect(response.status).toBe(200);
    return (response.body as { account: OwnAccount }).account;
  }

  async function signedInAt(schoolId: string, account: UserAccount): Promise<TestClient> {
    return (await server().sessionFor(account)).inSchool(schoolId);
  }

  async function link(
    admin: TestClient,
    guardian: Person,
    student: Person,
    accessProfile: AccessProfile = { attendanceRead: true, resultsRead: false },
  ): Promise<{ id: string }> {
    const response = await admin.post("/guardian-links", {
      guardianPersonId: guardian.id,
      studentPersonId: student.id,
      accessProfile,
    });
    expect(response.status).toBe(201);
    return (response.body as { guardianLink: { id: string } }).guardianLink;
  }

  it("tells a Faculty member they hold neither an Enrollment nor a link", async () => {
    const world = await arrange();
    const frankie = await signedInAt(world.northsideId, world.accounts.frankie);

    expect(await accountOf(frankie)).toEqual({ enrollment: null, linkedStudents: [] });
  });

  it("restates nothing the session already names", async () => {
    const world = await arrange();
    const frankie = await signedInAt(world.northsideId, world.accounts.frankie);

    // Who the actor is and which roles they hold are the session's to name, so
    // they cannot disagree with this response.
    const response = await frankie.get("/account");
    expect(Object.keys(response.body as { account: object }).length).toBe(1);
    expect(Object.keys((response.body as { account: object }).account).sort()).toEqual([
      "enrollment",
      "linkedStudents",
    ]);
  });

  it("names a Student's Enrollment", async () => {
    const world = await arrange();
    await server().enroll(world.samPerson);
    const sam = await signedInAt(world.northsideId, world.accounts.sam);

    const account = await accountOf(sam);
    expect(account.enrollment?.startedAt).toMatch(ISO_TIMESTAMP);
    expect(account.enrollment?.endedAt).toBeNull();
  });

  it("tells a Student holding no Enrollment that they hold none", async () => {
    const world = await arrange();
    const sam = await signedInAt(world.northsideId, world.accounts.sam);

    expect(await accountOf(sam)).toEqual({ enrollment: null, linkedStudents: [] });
  });

  it("tells a Student their Enrollment has ended, once it has", async () => {
    const world = await arrange();
    await server().enroll(world.samPerson);
    const enrollments = await world.aliceAdmin.get("/enrollments");
    const [enrollment] = (enrollments.body as { enrollments: { id: string }[] }).enrollments;
    expect((await world.aliceAdmin.delete(`/enrollments/${enrollment!.id}`, { reason: "Transfer" })).status).toBe(200);

    // A departed Student keeps their own Person, so they still reach this.
    const sam = await signedInAt(world.northsideId, world.accounts.sam);
    expect((await accountOf(sam)).enrollment?.endedAt).toMatch(ISO_TIMESTAMP);
  });

  it("names each Student a Guardian is linked to, and what that link permits", async () => {
    const world = await arrange();
    await server().enroll(world.samPerson);
    await link(world.aliceAdmin, world.ginaPerson, world.samPerson, {
      attendanceRead: true,
      resultsRead: false,
    });
    const gina = await signedInAt(world.northsideId, world.accounts.gina);

    expect(await accountOf(gina)).toEqual({
      enrollment: null,
      linkedStudents: [
        {
          student: { id: world.samPerson.id, displayName: "Sam" },
          accessProfile: { attendanceRead: true, resultsRead: false },
        },
      ],
    });
  });

  it("stops naming a Student once the link to them has ended", async () => {
    const world = await arrange();
    await server().enroll(world.samPerson);
    const linked = await link(world.aliceAdmin, world.ginaPerson, world.samPerson);
    expect((await world.aliceAdmin.delete(`/guardian-links/${linked.id}`)).status).toBe(200);

    const gina = await signedInAt(world.northsideId, world.accounts.gina);
    expect((await accountOf(gina)).linkedStudents).toEqual([]);
  });

  it("is refused outside the actor's School exactly as anything else is", async () => {
    const world = await arrange();
    const westbrook = await server().provisionSchool({
      name: "Westbrook",
      administrator: await server().createAccount(BOB),
    });
    const frankie = await server().sessionFor(world.accounts.frankie);

    // A School the account does not reach, and one that does not exist: the
    // same response, saying which of the two it was is exactly what would
    // tell the caller that Westbrook exists (ADR-0002).
    const elsewhere = await frankie.inSchool(westbrook.school.id).get("/account");
    const absent = await frankie.inSchool(randomUUID()).get("/account");
    expect(observable(elsewhere)).toEqual(observable(absent));
    expect(elsewhere.status).toBe(404);
  });
});
