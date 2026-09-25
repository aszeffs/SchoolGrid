import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { observable, useTestServer, type TestClient } from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const BOB = { username: "bob", password: "yet another staple, longer" };
const FRANKIE = { username: "frankie", password: "a faculty member's staple" };
const SAM = { username: "sam", password: "a different staple entirely" };
const GINA = { username: "gina", password: "a guardian's staple, twice over" };
const PAT = { username: "pat", password: "a platform operator's staple" };
const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

interface Recorded {
  actorPersonId: string | null;
  action: string;
  target: { type: string; id: string | null };
  reason: string | null;
  before: unknown;
  after: unknown;
}

interface Exception {
  id: string;
  date: string;
  instructional: boolean;
}

interface AcademicYear {
  id: string;
  name: string;
  firstDate: string;
  lastDate: string;
  weekdays: string[];
  exceptions: Exception[];
  instructionalDays: string[];
  terms: unknown[];
}

const MONDAY_TO_FRIDAY = ["monday", "tuesday", "wednesday", "thursday", "friday"];

/**
 * A fortnight, from Tuesday 1 September 2026 to Monday 14 September, short
 * enough that its Instructional days can be listed in full.
 */
const FORTNIGHT = { name: "A fortnight", firstDate: "2026-09-01", lastDate: "2026-09-14" };

/** FORTNIGHT's weekdays, Monday to Friday. */
const FORTNIGHT_WEEKDAYS = [
  "2026-09-01",
  "2026-09-02",
  "2026-09-03",
  "2026-09-04",
  "2026-09-07",
  "2026-09-08",
  "2026-09-09",
  "2026-09-10",
  "2026-09-11",
  "2026-09-14",
];

describe("Instructional days", () => {
  const server = useTestServer();

  interface World {
    northsideId: string;
    aliceId: string;
    /** Alice: Northside's School Administrator. Northside keeps New York's time. */
    alice: TestClient;
    /** Bob: Westbrook's School Administrator, and nothing at Northside. Westbrook keeps Manila's. */
    bob: TestClient;
  }

  interface WithCallers extends World {
    /** Frankie, Sam and Gina: Northside's Faculty member, enrolled Student, and linked Guardian. */
    frankie: TestClient;
    sam: TestClient;
    gina: TestClient;
    /** Pat: a Platform Administrator. */
    pat: TestClient;
  }

  async function arrange(): Promise<World> {
    const aliceAccount = await server().createAccount(ALICE);
    const bobAccount = await server().createAccount(BOB);
    const northside = await server().provisionSchool({
      name: "Northside",
      timezone: "America/New_York",
      administrator: aliceAccount,
    });
    const westbrook = await server().provisionSchool({
      name: "Westbrook",
      timezone: "Asia/Manila",
      administrator: bobAccount,
    });
    return {
      northsideId: northside.school.id,
      aliceId: northside.schoolAdministrator.id,
      alice: (await server().sessionFor(aliceAccount)).inSchool(northside.school.id),
      bob: (await server().sessionFor(bobAccount)).inSchool(westbrook.school.id),
    };
  }

  /** The world with a Northside Person in every other role, arranged only where a refusal is tried. */
  async function arrangeWithCallers(): Promise<WithCallers> {
    const world = await arrange();
    const schoolId = world.northsideId;
    const frankie = await server().createAccount(FRANKIE);
    const sam = await server().createAccount(SAM);
    const gina = await server().createAccount(GINA);
    const pat = await server().createAccount(PAT);
    await server().createPerson({
      schoolId,
      displayName: "Frankie",
      account: frankie,
      role: "faculty",
    });
    const samPerson = await server().createPerson({
      schoolId,
      displayName: "Sam",
      account: sam,
      role: "student",
    });
    await server().enroll(samPerson);
    await server().createPerson({
      schoolId,
      displayName: "Gina",
      account: gina,
      role: "guardian",
    });
    await server().createPlatformAdministrator({ account: pat });
    return {
      ...world,
      frankie: (await server().sessionFor(frankie)).inSchool(schoolId),
      sam: (await server().sessionFor(sam)).inSchool(schoolId),
      gina: (await server().sessionFor(gina)).inSchool(schoolId),
      pat: (await server().sessionFor(pat)).inSchool(schoolId),
    };
  }

  async function create(admin: TestClient, year: object = FORTNIGHT): Promise<AcademicYear> {
    const response = await admin.post("/academic-years", year);
    expect(response.status).toBe(201);
    return (response.body as { academicYear: AcademicYear }).academicYear;
  }

  async function addException(
    admin: TestClient,
    year: AcademicYear,
    exception: { date: string; instructional: boolean; reason?: string },
  ): Promise<AcademicYear> {
    const response = await admin.post(`/academic-years/${year.id}/exceptions`, exception);
    expect(response.status).toBe(201);
    return (response.body as { academicYear: AcademicYear }).academicYear;
  }

  async function yearOf(admin: TestClient, id: string): Promise<AcademicYear | undefined> {
    const response = await admin.get("/academic-years");
    expect(response.status).toBe(200);
    return (response.body as { academicYears: AcademicYear[] }).academicYears.find((year) => year.id === id);
  }

  async function trailOf(admin: TestClient, ...actions: string[]): Promise<Recorded[]> {
    const response = await admin.get("/audit-records");
    expect(response.status).toBe(200);
    return (response.body as { auditRecords: Recorded[] }).auditRecords.filter((record) =>
      actions.includes(record.action),
    );
  }

  /** Everything this slice stores, as the schema owner sees it. */
  async function stored() {
    const years = await server().ownerDatabase.query(
      "SELECT id, weekdays FROM app.academic_year ORDER BY id",
    );
    const exceptions = await server().ownerDatabase.query(
      "SELECT id, academic_year_id, date::text, instructional FROM app.instructional_day_exception ORDER BY id",
    );
    return { years: years.rows, exceptions: exceptions.rows };
  }

  describe("an Academic Year's weekday pattern", () => {
    it("is Monday to Friday unless the year is created with another, making its weekdays Instructional days", async () => {
      const world = await arrange();

      const year = await create(world.alice);

      expect(year).toEqual({
        id: expect.any(String),
        ...FORTNIGHT,
        weekdays: MONDAY_TO_FRIDAY,
        exceptions: [],
        instructionalDays: FORTNIGHT_WEEKDAYS,
        terms: [],
      });
      expect(await yearOf(world.alice, year.id)).toEqual(year);
    });

    it("may be given when the year is created, and is recorded with it", async () => {
      const world = await arrange();

      const year = await create(world.alice, { ...FORTNIGHT, weekdays: ["saturday", "monday"] });

      expect(year.weekdays).toEqual(["monday", "saturday"]);
      expect(year.instructionalDays).toEqual(["2026-09-05", "2026-09-07", "2026-09-12", "2026-09-14"]);
      expect(await trailOf(world.alice, "academic_year.created")).toEqual([
        expect.objectContaining({ after: { ...FORTNIGHT, weekdays: "monday,saturday" } }),
      ]);
    });

    it("is set by a School Administrator, recording it before and after", async () => {
      const world = await arrange();
      const year = await create(world.alice);

      const response = await world.alice.patch(`/academic-years/${year.id}`, {
        weekdays: ["monday", "wednesday", "friday"],
        reason: "Three-day weeks",
      });

      expect(response.status).toBe(200);
      const { academicYear } = response.body as { academicYear: AcademicYear };
      expect(academicYear.weekdays).toEqual(["monday", "wednesday", "friday"]);
      expect(academicYear.instructionalDays).toEqual([
        "2026-09-02",
        "2026-09-04",
        "2026-09-07",
        "2026-09-09",
        "2026-09-11",
        "2026-09-14",
      ]);
      expect(await trailOf(world.alice, "academic_year.changed")).toEqual([
        {
          id: expect.any(String),
          occurredAt: expect.any(String),
          actorPersonId: world.aliceId,
          actorPlatformAdministratorId: null,
          action: "academic_year.changed",
          target: { type: "academic_year", id: year.id },
          reason: "Three-day weeks",
          before: { ...FORTNIGHT, weekdays: "monday,tuesday,wednesday,thursday,friday" },
          after: { ...FORTNIGHT, weekdays: "monday,wednesday,friday" },
        },
      ]);
    });

    it("may be empty, leaving only the days put in", async () => {
      const world = await arrange();
      const year = await create(world.alice);

      const response = await world.alice.patch(`/academic-years/${year.id}`, { weekdays: [] });

      expect(response.status).toBe(200);
      expect((response.body as { academicYear: AcademicYear }).academicYear.instructionalDays).toEqual([]);
    });

    it("records nothing when set to the days it already has, in whatever order", async () => {
      const world = await arrange();
      const year = await create(world.alice);

      const response = await world.alice.patch(`/academic-years/${year.id}`, {
        weekdays: [...MONDAY_TO_FRIDAY].reverse(),
      });

      expect(response.status).toBe(200);
      expect(await trailOf(world.alice, "academic_year.changed")).toEqual([]);
    });

    it.each([
      ["not a list", "monday"],
      ["a day that is not a weekday's name", ["monday", "funday"]],
      ["a day named twice", ["monday", "monday"]],
      ["a day named in capitals", ["Monday"]],
    ])("rejects a pattern that is %s", async (_case, weekdays) => {
      const world = await arrange();
      const year = await create(world.alice);
      const before = await stored();

      const created = await world.alice.post("/academic-years", { ...FORTNIGHT, firstDate: "2027-01-01", lastDate: "2027-01-31", weekdays });
      const changed = await world.alice.patch(`/academic-years/${year.id}`, { weekdays });

      expect([created.status, changed.status]).toEqual([400, 400]);
      expect(await stored()).toEqual(before);
    });
  });

  describe("an exception", () => {
    it("takes a date out as a holiday, or puts one in as a make-up day, listed in date order", async () => {
      const world = await arrange();
      const year = await create(world.alice);

      await addException(world.alice, year, { date: "2026-09-12", instructional: true });
      const changed = await addException(world.alice, year, { date: "2026-09-07", instructional: false });

      expect(changed.exceptions).toEqual([
        { id: expect.any(String), date: "2026-09-07", instructional: false },
        { id: expect.any(String), date: "2026-09-12", instructional: true },
      ]);
      expect(changed.instructionalDays).toEqual(
        [...FORTNIGHT_WEEKDAYS.filter((day) => day !== "2026-09-07"), "2026-09-12"].sort(),
      );
      expect(await yearOf(world.alice, year.id)).toEqual(changed);
    });

    it("stands whatever the pattern later becomes", async () => {
      const world = await arrange();
      const year = await create(world.alice);
      await addException(world.alice, year, { date: "2026-09-12", instructional: true });
      await addException(world.alice, year, { date: "2026-09-07", instructional: false });

      const response = await world.alice.patch(`/academic-years/${year.id}`, { weekdays: ["monday", "saturday"] });

      expect((response.body as { academicYear: AcademicYear }).academicYear.instructionalDays).toEqual([
        "2026-09-05",
        "2026-09-12",
        "2026-09-14",
      ]);
    });

    it("is recorded when added, against the year it belongs to", async () => {
      const world = await arrange();
      const year = await create(world.alice);

      const changed = await addException(world.alice, year, {
        date: "2026-09-07",
        instructional: false,
        reason: "Labor Day",
      });

      expect(await trailOf(world.alice, "instructional_day_exception.created")).toEqual([
        {
          id: expect.any(String),
          occurredAt: expect.any(String),
          actorPersonId: world.aliceId,
          actorPlatformAdministratorId: null,
          action: "instructional_day_exception.created",
          target: { type: "instructional_day_exception", id: changed.exceptions[0]!.id },
          reason: "Labor Day",
          before: null,
          after: { academicYearId: year.id, date: "2026-09-07", instructional: false },
        },
      ]);
    });

    it("is removed, returning the date to its pattern and recording what it was", async () => {
      const world = await arrange();
      const year = await create(world.alice);
      const withHoliday = await addException(world.alice, year, { date: "2026-09-07", instructional: false });
      const exceptionId = withHoliday.exceptions[0]!.id;

      const response = await world.alice.delete(`/academic-years/${year.id}/exceptions/${exceptionId}`, {
        reason: "Open after all",
      });

      expect(response.status).toBe(200);
      const { academicYear } = response.body as { academicYear: AcademicYear };
      expect(academicYear.exceptions).toEqual([]);
      expect(academicYear.instructionalDays).toEqual(FORTNIGHT_WEEKDAYS);
      expect(await trailOf(world.alice, "instructional_day_exception.deleted")).toEqual([
        expect.objectContaining({
          target: { type: "instructional_day_exception", id: exceptionId },
          reason: "Open after all",
          before: { academicYearId: year.id, date: "2026-09-07", instructional: false },
          after: null,
        }),
      ]);
    });

    it.each([
      ["the day before the year begins", "2026-08-31"],
      ["the day after the year ends", "2026-09-15"],
      ["a date in another of the School's years", "2026-10-01"],
    ])("is refused on %s, naming the rule", async (_case, date) => {
      const world = await arrange();
      const year = await create(world.alice);
      await create(world.alice, { name: "October", firstDate: "2026-10-01", lastDate: "2026-10-31" });
      const before = await stored();

      const response = await world.alice.post(`/academic-years/${year.id}/exceptions`, { date, instructional: true });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ status: "conflict", conflict: "exception_outside_academic_year" });
      expect(await stored()).toEqual(before);
      expect(await trailOf(world.alice, "instructional_day_exception.created")).toEqual([]);
    });

    it.each([
      ["the same kind", false],
      ["the other kind", true],
    ])("is refused on a date that already has one of %s", async (_case, instructional) => {
      const world = await arrange();
      const year = await create(world.alice);
      await addException(world.alice, year, { date: "2026-09-07", instructional: false });
      const before = await stored();

      const response = await world.alice.post(`/academic-years/${year.id}/exceptions`, {
        date: "2026-09-07",
        instructional,
      });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ status: "conflict", conflict: "exception_date_taken" });
      expect(await stored()).toEqual(before);
    });

    it.each([
      ["no date", { instructional: false }],
      ["a date that does not exist", { date: "2026-09-31", instructional: false }],
      ["a moment rather than a date", { date: "2026-09-07T00:00:00Z", instructional: false }],
      ["no kind", { date: "2026-09-07" }],
      ["a kind that is not true or false", { date: "2026-09-07", instructional: "no" }],
      ["a field it does not take", { date: "2026-09-07", instructional: false, kind: "holiday" }],
    ])("is rejected with %s", async (_case, body) => {
      const world = await arrange();
      const year = await create(world.alice);

      const response = await world.alice.post(`/academic-years/${year.id}/exceptions`, body);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ status: "invalid_request" });
    });

    it("holds the year's bounds: shrinking the year past it strands it", async () => {
      const world = await arrange();
      const year = await create(world.alice);
      await addException(world.alice, year, { date: "2026-09-12", instructional: true });

      const shrunk = await world.alice.patch(`/academic-years/${year.id}`, { lastDate: "2026-09-11" });
      const kept = await world.alice.patch(`/academic-years/${year.id}`, { lastDate: "2026-09-12" });

      expect(shrunk.status).toBe(409);
      expect(shrunk.body).toEqual({ status: "conflict", conflict: "dependent", dependent: "instructional_day_exception" });
      expect(kept.status).toBe(200);
    });

    it("keeps its year from being deleted, naming it as what depends on the year", async () => {
      const world = await arrange();
      const year = await create(world.alice);
      await addException(world.alice, year, { date: "2026-09-07", instructional: false });

      const response = await world.alice.delete(`/academic-years/${year.id}`);

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ status: "conflict", conflict: "dependent", dependent: "instructional_day_exception" });
      expect(await yearOf(world.alice, year.id)).toBeDefined();
    });

    it("cannot share a date with another even when written directly", async () => {
      const world = await arrange();
      const year = await create(world.alice);
      await addException(world.alice, year, { date: "2026-09-07", instructional: false });

      await expect(
        server().database.query(
          `INSERT INTO app.instructional_day_exception (school_id, academic_year_id, date, instructional)
           VALUES ($1, $2, '2026-09-07', true)`,
          [world.northsideId, year.id],
        ),
      ).rejects.toThrow(/unique/);
    });

    it("cannot belong to another School's year even when written directly", async () => {
      const world = await arrange();
      const year = await create(world.bob);

      await expect(
        server().database.query(
          `INSERT INTO app.instructional_day_exception (school_id, academic_year_id, date, instructional)
           VALUES ($1, $2, '2026-09-07', false)`,
          [world.northsideId, year.id],
        ),
      ).rejects.toThrow(/foreign key/);
    });
  });

  describe("the School calendar", () => {
    async function askAt(client: TestClient, at: string) {
      const response = await client.get(`/school-date?at=${encodeURIComponent(at)}`);
      expect(response.status).toBe(200);
      return response.body as { schoolDate: string; instructionalDay: boolean };
    }

    /** Northside's 2026, Monday to Friday, spanning both of New York's clock changes. */
    async function arrangeCalendarYear() {
      const world = await arrange();
      const year = await create(world.alice, { name: "2026", firstDate: "2026-01-01", lastDate: "2026-12-31" });
      return { world, year };
    }

    it.each([
      // New York's clocks go forward on Sunday 8 March, so Monday the 9th begins at 04:00 UTC.
      ["the last moment of the Sunday the clocks go forward", "2026-03-09T03:59:59.999Z", "2026-03-08", false],
      ["the midnight that begins the Monday after", "2026-03-09T04:00:00Z", "2026-03-09", true],
      // And back on Sunday 1 November, so Monday the 2nd begins at 05:00 UTC.
      ["the last moment of the Sunday the clocks go back", "2026-11-02T04:59:59.999Z", "2026-11-01", false],
      ["the midnight that begins the Monday after", "2026-11-02T05:00:00Z", "2026-11-02", true],
      // Friday 6 November ends at 05:00 UTC on the 7th, a Saturday.
      ["the last moment of a Friday", "2026-11-07T04:59:59.999Z", "2026-11-06", true],
      ["the midnight that begins the Saturday", "2026-11-07T05:00:00Z", "2026-11-07", false],
    ])("answers whether a School date is an Instructional day, in New York at %s", async (_case, at, date, answer) => {
      const { world } = await arrangeCalendarYear();

      expect(await askAt(world.alice, at)).toEqual({ schoolDate: date, instructionalDay: answer });
    });

    it("answers by the School's own date, so one instant can be a school day in one School and not another", async () => {
      const { world } = await arrangeCalendarYear();
      await create(world.bob, { name: "2026", firstDate: "2026-01-01", lastDate: "2026-12-31" });

      // 20:00 on Friday 6 November in New York is already Saturday morning in Manila.
      const at = "2026-11-07T01:00:00Z";

      expect(await askAt(world.alice, at)).toEqual({ schoolDate: "2026-11-06", instructionalDay: true });
      expect(await askAt(world.bob, at)).toEqual({ schoolDate: "2026-11-07", instructionalDay: false });
    });

    it("counts a holiday out and a make-up day in, on the dates they fall on across the clock change", async () => {
      const { world, year } = await arrangeCalendarYear();
      await addException(world.alice, year, { date: "2026-03-09", instructional: false });
      await addException(world.alice, year, { date: "2026-03-08", instructional: true });

      expect(await askAt(world.alice, "2026-03-09T03:59:59.999Z")).toEqual({
        schoolDate: "2026-03-08",
        instructionalDay: true,
      });
      expect(await askAt(world.alice, "2026-03-09T04:00:00Z")).toEqual({
        schoolDate: "2026-03-09",
        instructionalDay: false,
      });
    });

    it("answers no for a weekday in no Academic Year", async () => {
      const { world } = await arrangeCalendarYear();

      // Friday 1 January 2027, the day after the year ends.
      expect(await askAt(world.alice, "2027-01-01T17:00:00Z")).toEqual({
        schoolDate: "2027-01-01",
        instructionalDay: false,
      });
    });
  });

  describe("outside the caller's reach is the standard refusal", () => {
    async function arrangeWithException() {
      const world = await arrangeWithCallers();
      const year = await addException(world.alice, await create(world.alice), {
        date: "2026-09-07",
        instructional: false,
      });
      return { world, year, exceptionId: year.exceptions[0]!.id };
    }

    const attempts = [
      ["setting the pattern", (c: TestClient, y: string) => c.patch(`/academic-years/${y}`, { weekdays: ["monday"] })],
      [
        "adding an exception",
        (c: TestClient, y: string) => c.post(`/academic-years/${y}/exceptions`, { date: "2026-09-08", instructional: false }),
      ],
      ["adding a malformed exception", (c: TestClient, y: string) => c.post(`/academic-years/${y}/exceptions`, { date: 5 })],
      ["removing an exception", (c: TestClient, y: string, e: string) => c.delete(`/academic-years/${y}/exceptions/${e}`)],
      ["asking the School calendar", (c: TestClient) => c.get("/school-date?at=2026-09-07T12:00:00Z")],
    ] as const;

    const callers = [
      ["a Faculty member", (w: WithCallers) => w.frankie],
      ["a Student", (w: WithCallers) => w.sam],
      ["a Guardian", (w: WithCallers) => w.gina],
      ["another School's Administrator", (w: WithCallers) => w.bob.inSchool(w.northsideId)],
      ["a Platform Administrator", (w: WithCallers) => w.pat],
      ["a caller with no session", (w: WithCallers) => server().client.inSchool(w.northsideId)],
    ] as const;

    it.each(callers)(
      "refuses %s every action exactly as an absent Person is refused, changing nothing",
      async (_caller, as) => {
        const { world, year, exceptionId } = await arrangeWithException();
        const before = await stored();
        const absent = await world.sam.get(`/persons/${ABSENT_ID}`);
        expect(absent.status).not.toBe(200);

        const answered: string[] = [];
        for (const [what, attempt] of attempts) {
          const refused = await attempt(as(world), year.id, exceptionId);
          if (!isDeepStrictEqual(observable(refused), observable(absent))) {
            answered.push(`${what} answered ${refused.status}`);
          }
        }

        expect(answered).toEqual([]);
        expect(await stored()).toEqual(before);
      },
    );

    it("refuses removing an exception that does not exist, or is another year's or School's, identically", async () => {
      const { world, year, exceptionId } = await arrangeWithException();
      const other = await addException(
        world.alice,
        await create(world.alice, { name: "October", firstDate: "2026-10-01", lastDate: "2026-10-31" }),
        { date: "2026-10-12", instructional: false },
      );
      const before = await stored();

      const responses = [
        await world.alice.delete(`/academic-years/${year.id}/exceptions/${ABSENT_ID}`),
        await world.alice.delete(`/academic-years/${year.id}/exceptions/not-an-identifier`),
        await world.alice.delete(`/academic-years/${year.id}/exceptions/${other.exceptions[0]!.id}`),
        await world.alice.delete(`/academic-years/${ABSENT_ID}/exceptions/${exceptionId}`),
        await world.bob.delete(`/academic-years/${year.id}/exceptions/${exceptionId}`),
      ];
      const refusal = await world.sam.get(`/persons/${ABSENT_ID}`);

      for (const response of responses) {
        expect(observable(response)).toEqual(observable(refusal));
      }
      expect(await stored()).toEqual(before);
    });

    it("records a refused change with its true reason", async () => {
      const { world, year, exceptionId } = await arrangeWithException();

      await world.frankie.post(`/academic-years/${year.id}/exceptions`, { date: "2026-09-08", instructional: false });
      await world.alice.delete(`/academic-years/${year.id}/exceptions/${ABSENT_ID}`);
      await world.bob.delete(`/academic-years/${year.id}/exceptions/${exceptionId}`);

      expect(await trailOf(world.alice, "access.refused")).toEqual([
        expect.objectContaining({
          reason: "absent",
          target: { type: "instructional_day_exception", id: ABSENT_ID },
        }),
        expect.objectContaining({ reason: "forbidden", target: { type: "academic_year", id: year.id } }),
      ]);
      expect(await trailOf(world.bob, "access.refused")).toEqual([
        expect.objectContaining({ reason: "outside-school", target: { type: "academic_year", id: year.id } }),
      ]);
    });
  });
});
