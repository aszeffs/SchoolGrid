import { describe, expect, it } from "vitest";
import { observable, useTestServer, type TestClient } from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const BOB = { username: "bob", password: "yet another staple, longer" };
const FRANKIE = { username: "frankie", password: "a faculty member's staple" };
const SAM = { username: "sam", password: "a different staple entirely" };
const GINA = { username: "gina", password: "a guardian's staple, twice over" };
const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

interface Recorded {
  actorPersonId: string | null;
  action: string;
  target: { type: string; id: string | null };
  reason: string | null;
  before: unknown;
  after: unknown;
}

describe("School settings", () => {
  const server = useTestServer();

  interface World {
    northsideId: string;
    westbrookId: string;
    aliceId: string;
    /** Alice: Northside's School Administrator. */
    alice: TestClient;
    /** Bob: Westbrook's School Administrator, and nothing at Northside. */
    bob: TestClient;
    /** Frankie, Sam and Gina: Northside's Faculty member, enrolled Student, and linked Guardian. */
    frankie: TestClient;
    sam: TestClient;
    gina: TestClient;
  }

  /** Northside keeps its time in New York, and Westbrook in Manila. */
  async function arrange(): Promise<World> {
    const alice = await server().createAccount(ALICE);
    const bob = await server().createAccount(BOB);
    const frankie = await server().createAccount(FRANKIE);
    const sam = await server().createAccount(SAM);
    const gina = await server().createAccount(GINA);
    const northside = await server().provisionSchool({
      name: "Northside",
      timezone: "America/New_York",
      administrator: alice,
    });
    const westbrook = await server().provisionSchool({ name: "Westbrook", timezone: "Asia/Manila", administrator: bob });
    const schoolId = northside.school.id;
    await server().createPerson({ schoolId, displayName: "Frankie", account: frankie, role: "faculty" });
    await server().enroll(await server().createPerson({ schoolId, displayName: "Sam", account: sam, role: "student" }));
    await server().createPerson({ schoolId, displayName: "Gina", account: gina, role: "guardian" });
    return {
      northsideId: schoolId,
      westbrookId: westbrook.school.id,
      aliceId: northside.schoolAdministrator.id,
      alice: (await server().sessionFor(alice)).inSchool(schoolId),
      bob: (await server().sessionFor(bob)).inSchool(westbrook.school.id),
      frankie: (await server().sessionFor(frankie)).inSchool(schoolId),
      sam: (await server().sessionFor(sam)).inSchool(schoolId),
      gina: (await server().sessionFor(gina)).inSchool(schoolId),
    };
  }

  async function timezoneOf(admin: TestClient): Promise<string> {
    const response = await admin.get("/settings");
    expect(response.status).toBe(200);
    return (response.body as { settings: { timezone: string } }).settings.timezone;
  }

  async function trailOf(admin: TestClient, action: string): Promise<Recorded[]> {
    const response = await admin.get("/audit-records");
    expect(response.status).toBe(200);
    return (response.body as { auditRecords: Recorded[] }).auditRecords.filter(
      (record) => record.action === action,
    );
  }

  describe("reading", () => {
    it("gives a School Administrator the School's timezone, and the timezones it may be set to", async () => {
      const world = await arrange();

      const response = await world.alice.get("/settings");

      expect(response.status).toBe(200);
      const { settings, timezones } = response.body as { settings: unknown; timezones: string[] };
      expect(settings).toEqual({ timezone: "America/New_York", timezoneFixed: false });
      expect(timezones).toEqual(expect.arrayContaining(["America/New_York", "Asia/Manila", "Europe/London", "UTC"]));
      expect(timezones).toEqual([...timezones].sort());
    });
  });

  describe("changing the timezone", () => {
    it("lets a School Administrator change it, recording the value before and after", async () => {
      const world = await arrange();

      const response = await world.alice.patch("/settings", { timezone: "Europe/London" });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ settings: { timezone: "Europe/London", timezoneFixed: false } });
      expect(await timezoneOf(world.alice)).toBe("Europe/London");
      expect(await trailOf(world.alice, "school.settings_changed")).toEqual([
        {
          id: expect.any(String),
          occurredAt: expect.any(String),
          actorPersonId: world.aliceId,
          actorPlatformAdministratorId: null,
          action: "school.settings_changed",
          target: { type: "school", id: world.northsideId },
          reason: null,
          before: { timezone: "America/New_York" },
          after: { timezone: "Europe/London" },
        },
      ]);
    });

    it("records the reason given for a change", async () => {
      const world = await arrange();

      await world.alice.patch("/settings", { timezone: "America/Chicago", reason: "Set in error at provisioning" });

      expect(await trailOf(world.alice, "school.settings_changed")).toEqual([
        expect.objectContaining({ reason: "Set in error at provisioning" }),
      ]);
    });

    it("records nothing for a change stating the timezone the School already has", async () => {
      const world = await arrange();

      const response = await world.alice.patch("/settings", { timezone: "America/New_York" });

      expect(response.status).toBe(200);
      expect(await trailOf(world.alice, "school.settings_changed")).toEqual([]);
    });

    it("leaves every other School's timezone as it was", async () => {
      const world = await arrange();

      await world.alice.patch("/settings", { timezone: "Europe/London" });

      expect(await timezoneOf(world.bob)).toBe("Asia/Manila");
    });

    it.each([
      ["a name that is no IANA timezone", { timezone: "Mars/Olympus_Mons" }],
      ["a timezone in the wrong letter case", { timezone: "america/new_york" }],
      ["a timezone padded with spaces", { timezone: " Europe/London" }],
      ["an empty timezone", { timezone: "" }],
      ["a timezone that is not text", { timezone: -5 }],
      ["no timezone at all", {}],
      ["a field there is no setting for", { timezone: "Europe/London", name: "Renamed" }],
      ["a body that is not an object", ["Europe/London"]],
    ])("rejects %s, changing nothing", async (_case, body) => {
      const world = await arrange();

      const response = await world.alice.patch("/settings", body);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ status: "invalid_request" });
      expect(await timezoneOf(world.alice)).toBe("America/New_York");
      expect(await trailOf(world.alice, "school.settings_changed")).toEqual([]);
    });

    it("does not change a timezone whose Audit record cannot be written", async () => {
      const world = await arrange();
      await server().ownerDatabase.query("REVOKE INSERT ON app.audit_record FROM schoolgrid_app");

      await world.alice.patch("/settings", { timezone: "Europe/London" });

      const { rows } = await server().ownerDatabase.query<{ timezone: string }>(
        "SELECT timezone FROM app.school WHERE id = $1",
        [world.northsideId],
      );
      expect(rows).toEqual([{ timezone: "America/New_York" }]);
    });

    it("refuses a timezone the database does not know even when written directly", async () => {
      const world = await arrange();

      await expect(
        server().database.query("UPDATE app.school SET timezone = 'Mars/Olympus_Mons' WHERE id = $1", [
          world.northsideId,
        ]),
      ).rejects.toThrow(/timezone/);
      await expect(
        server().database.query("INSERT INTO app.school (name, timezone) VALUES ('Eastfield', 'Nowhere/At_All')"),
      ).rejects.toThrow(/timezone/);
    });

    it("leaves the application unable to rename or delete a School", async () => {
      const world = await arrange();
      const database = server().database;

      await expect(
        database.query("UPDATE app.school SET name = 'Renamed' WHERE id = $1", [world.northsideId]),
      ).rejects.toThrow(/permission denied/);
      await expect(database.query("DELETE FROM app.school WHERE id = $1", [world.westbrookId])).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  describe("the School date an instant falls on", () => {
    async function schoolDateAt(client: TestClient, at: string) {
      const response = await client.get(`/school-date?at=${encodeURIComponent(at)}`);
      expect(response.status).toBe(200);
      return response.body as { schoolDate: string; instructionalDay: boolean };
    }

    it("is the calendar date in the School's timezone, not in UTC", async () => {
      const world = await arrange();

      // 03:00 on 24 September in UTC is still the 23rd in New York, and
      // already 11:00 on the 24th in Manila.
      expect(await schoolDateAt(world.alice, "2026-09-24T03:00:00Z")).toEqual({
        schoolDate: "2026-09-23",
        // Northside has no Academic Year, so none of its days is an Instructional day.
        instructionalDay: false,
      });
      expect((await schoolDateAt(world.bob, "2026-09-24T03:00:00Z")).schoolDate).toBe("2026-09-24");
    });

    it.each([
      // New York keeps EST (UTC-5) until 07:00 UTC on 8 March 2026.
      ["just before midnight, west of UTC", "2026-03-07T04:59:59.999Z", "2026-03-06"],
      ["at midnight, west of UTC", "2026-03-07T05:00:00Z", "2026-03-07"],
      // The clocks go forward on the 8th, so the 9th begins an hour earlier in UTC.
      ["the last moment of the day the clocks change", "2026-03-09T03:59:59.999Z", "2026-03-08"],
      ["the midnight after the clocks change", "2026-03-09T04:00:00Z", "2026-03-09"],
      // And back on 1 November, so the 2nd begins an hour later again.
      ["just before midnight after the clocks go back", "2026-11-02T04:59:59.999Z", "2026-11-01"],
      ["the midnight after the clocks go back", "2026-11-02T05:00:00Z", "2026-11-02"],
      // An instant written with an offset is the same instant.
      ["an instant written with an offset", "2026-03-07T00:30:00+01:00", "2026-03-06"],
    ])("in New York, %s", async (_case, at, schoolDate) => {
      const world = await arrange();

      expect((await schoolDateAt(world.alice, at)).schoolDate).toBe(schoolDate);
    });

    it.each([
      // Manila keeps UTC+8 all year, so its midnight is 16:00 UTC the day before.
      ["just before midnight, east of UTC", "2026-09-23T15:59:59.999Z", "2026-09-23"],
      ["at midnight, east of UTC", "2026-09-23T16:00:00Z", "2026-09-24"],
    ])("in Manila, %s", async (_case, at, schoolDate) => {
      const world = await arrange();

      expect((await schoolDateAt(world.bob, at)).schoolDate).toBe(schoolDate);
    });

    it("follows the School's timezone once it has changed", async () => {
      const world = await arrange();
      const at = "2026-09-24T03:00:00Z";
      expect((await schoolDateAt(world.alice, at)).schoolDate).toBe("2026-09-23");

      await world.alice.patch("/settings", { timezone: "Asia/Tokyo" });

      expect((await schoolDateAt(world.alice, at)).schoolDate).toBe("2026-09-24");
    });

    it("is today's School date when no instant is named", async () => {
      const world = await arrange();
      const inNewYork = () =>
        new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
      const before = inNewYork();

      const response = await world.alice.get("/school-date");

      expect(response.status).toBe(200);
      const { schoolDate } = response.body as { schoolDate: string };
      expect([before, inNewYork()]).toContain(schoolDate);
    });

    it.each([
      ["a date with no time", "2026-03-08"],
      ["a time with no offset", "2026-03-08T12:00:00"],
      ["a date that does not exist", "2026-02-30T12:00:00Z"],
      ["something else entirely", "yesterday"],
    ])("rejects %s", async (_case, at) => {
      const world = await arrange();

      const response = await world.alice.get(`/school-date?at=${encodeURIComponent(at)}`);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ status: "invalid_request" });
    });

    it("rejects an instant named more than once", async () => {
      const world = await arrange();

      const response = await world.alice.get("/school-date?at=2026-03-08T12:00:00Z&at=2026-03-09T12:00:00Z");

      expect(response.status).toBe(400);
    });
  });

  describe("outside the caller's reach is the standard refusal", () => {
    it.each([
      ["a Faculty member reading the settings", (w: World) => w.frankie.get("/settings")],
      ["a Faculty member changing the timezone", (w: World) => w.frankie.patch("/settings", { timezone: "UTC" })],
      ["a Student reading the settings", (w: World) => w.sam.get("/settings")],
      ["a Student changing the timezone", (w: World) => w.sam.patch("/settings", { timezone: "UTC" })],
      ["a Guardian reading the settings", (w: World) => w.gina.get("/settings")],
      ["a Guardian changing the timezone", (w: World) => w.gina.patch("/settings", { timezone: "UTC" })],
      ["a Guardian sending a malformed change", (w: World) => w.gina.patch("/settings", { timezone: 5 })],
      ["a Faculty member asking the School date", (w: World) => w.frankie.get("/school-date?at=2026-03-08T12:00:00Z")],
      ["a Student asking the School date", (w: World) => w.sam.get("/school-date")],
      ["a Guardian asking the School date of a malformed instant", (w: World) => w.gina.get("/school-date?at=soon")],
      ["another School's Administrator reading the settings", (w: World) => w.bob.inSchool(w.northsideId).get("/settings")],
      [
        "another School's Administrator changing the timezone",
        (w: World) => w.bob.inSchool(w.northsideId).patch("/settings", { timezone: "UTC" }),
      ],
      [
        "another School's Administrator asking the School date",
        (w: World) => w.bob.inSchool(w.northsideId).get("/school-date"),
      ],
      ["a caller with no session reading the settings", (w: World) => server().client.inSchool(w.northsideId).get("/settings")],
      [
        "a caller with no session changing the timezone",
        (w: World) => server().client.inSchool(w.northsideId).patch("/settings", { timezone: "UTC" }),
      ],
      ["reading the settings of a School that does not exist", (w: World) => w.bob.inSchool(ABSENT_ID).get("/settings")],
    ] as const)("refuses %s exactly as an absent Person is refused, changing nothing", async (_case, attempt) => {
      const world = await arrange();
      const rows = () => server().ownerDatabase.query("SELECT id, name, timezone FROM app.school ORDER BY id");
      const before = await rows();

      const refused = await attempt(world);
      const absent = await world.sam.get(`/persons/${ABSENT_ID}`);

      expect(absent.status).not.toBe(200);
      expect(observable(refused)).toEqual(observable(absent));
      expect((await rows()).rows).toEqual(before.rows);
    });

    it("records a refused change with its true reason", async () => {
      const world = await arrange();

      await world.frankie.patch("/settings", { timezone: "UTC" });

      expect(await trailOf(world.alice, "access.refused")).toEqual([
        expect.objectContaining({
          reason: "forbidden",
          target: { type: "school", id: world.northsideId },
        }),
      ]);
    });
  });
});
