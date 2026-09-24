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

interface Term {
  id: string;
  name: string;
  firstDate: string;
  lastDate: string;
}

interface AcademicYear {
  id: string;
  name: string;
  firstDate: string;
  lastDate: string;
  weekdays: string[];
  exceptions: unknown[];
  instructionalDays: string[];
  terms: Term[];
}

/** A year running from September to June, as most do. */
const YEAR = { name: "2026–27", firstDate: "2026-09-01", lastDate: "2027-06-30" };

/** YEAR as its Audit record holds it, with the weekday pattern it is given unless told otherwise. */
const YEAR_VALUES = { ...YEAR, weekdays: "monday,tuesday,wednesday,thursday,friday" };

/** Two Terms covering YEAR exactly, the second starting the day after the first ends. */
const HALVES = [
  { name: "Fall", firstDate: "2026-09-01", lastDate: "2027-01-15" },
  { name: "Spring", firstDate: "2027-01-16", lastDate: "2027-06-30" },
];

describe("Academic Years and Terms", () => {
  const server = useTestServer();

  interface World {
    northsideId: string;
    westbrookId: string;
    aliceId: string;
    /** Alice: Northside's School Administrator. */
    alice: TestClient;
    /** Bob: Westbrook's School Administrator, and nothing at Northside. */
    bob: TestClient;
  }

  /** Everyone else a refusal is tried as, arranged only where one is. */
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
      westbrookId: westbrook.school.id,
      aliceId: northside.schoolAdministrator.id,
      alice: (await server().sessionFor(aliceAccount)).inSchool(northside.school.id),
      bob: (await server().sessionFor(bobAccount)).inSchool(westbrook.school.id),
    };
  }

  /**
   * The world, with a Northside Person in every other role and a Platform
   * Administrator, arranged only where a refusal is tried.
   */
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

  async function create(admin: TestClient, year: object = YEAR): Promise<AcademicYear> {
    const response = await admin.post("/academic-years", year);
    expect(response.status).toBe(201);
    return (response.body as { academicYear: AcademicYear }).academicYear;
  }

  /** YEAR, divided into HALVES. */
  async function createDivided(admin: TestClient): Promise<AcademicYear> {
    const year = await create(admin);
    const response = await admin.patch(`/academic-years/${year.id}`, { terms: HALVES });
    expect(response.status).toBe(200);
    return (response.body as { academicYear: AcademicYear }).academicYear;
  }

  async function yearsOf(admin: TestClient): Promise<AcademicYear[]> {
    const response = await admin.get("/academic-years");
    expect(response.status).toBe(200);
    return (response.body as { academicYears: AcademicYear[] }).academicYears;
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
      "SELECT id, school_id, name, first_date::text, last_date::text FROM app.academic_year ORDER BY id",
    );
    const terms = await server().ownerDatabase.query(
      "SELECT id, academic_year_id, name, first_date::text, last_date::text FROM app.term ORDER BY id",
    );
    return { years: years.rows, terms: terms.rows };
  }

  function terms(year: AcademicYear) {
    return year.terms.map(({ name, firstDate, lastDate }) => ({ name, firstDate, lastDate }));
  }

  describe("an Academic Year", () => {
    it("is created with a name and its first and last School dates, and no Terms yet", async () => {
      const world = await arrange();

      const response = await world.alice.post("/academic-years", YEAR);

      expect(response.status).toBe(201);
      const { academicYear } = response.body as { academicYear: AcademicYear };
      expect(academicYear).toEqual({
        id: expect.any(String),
        ...YEAR,
        weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
        exceptions: [],
        instructionalDays: expect.any(Array),
        terms: [],
      });
      expect(await yearsOf(world.alice)).toEqual([academicYear]);
    });

    it("records its creation with the values it was created with, and the reason given", async () => {
      const world = await arrange();

      const response = await world.alice.post("/academic-years", { ...YEAR, reason: "Planning next year" });
      const { academicYear } = response.body as { academicYear: AcademicYear };

      expect(await trailOf(world.alice, "academic_year.created")).toEqual([
        {
          id: expect.any(String),
          occurredAt: expect.any(String),
          actorPersonId: world.aliceId,
          actorPlatformAdministratorId: null,
          action: "academic_year.created",
          target: { type: "academic_year", id: academicYear.id },
          reason: "Planning next year",
          before: null,
          after: YEAR_VALUES,
        },
      ]);
    });

    it("is listed in date order, whatever order the years were created in", async () => {
      const world = await arrange();
      const later = await create(world.alice, { name: "2027–28", firstDate: "2027-09-01", lastDate: "2028-06-30" });
      const earlier = await create(world.alice);

      expect((await yearsOf(world.alice)).map((year) => year.id)).toEqual([earlier.id, later.id]);
    });

    it("may leave School dates between it and the next, such as a summer break", async () => {
      const world = await arrange();
      await create(world.alice);

      const response = await world.alice.post("/academic-years", {
        name: "2027–28",
        firstDate: "2027-09-01",
        lastDate: "2028-06-30",
      });

      expect(response.status).toBe(201);
    });

    it("may begin the day after another ends", async () => {
      const world = await arrange();
      await create(world.alice);

      const response = await world.alice.post("/academic-years", {
        name: "Summer",
        firstDate: "2027-07-01",
        lastDate: "2027-08-31",
      });

      expect(response.status).toBe(201);
    });

    it("may last a single day", async () => {
      const world = await arrange();

      const response = await world.alice.post("/academic-years", {
        name: "Orientation",
        firstDate: "2026-08-31",
        lastDate: "2026-08-31",
      });

      expect(response.status).toBe(201);
    });

    it.each([
      ["the same dates", YEAR],
      ["its first day falling on another's last", { name: "Next", firstDate: "2027-06-30", lastDate: "2028-06-30" }],
      ["its last day falling on another's first", { name: "Before", firstDate: "2025-09-01", lastDate: "2026-09-01" }],
      ["lying wholly within another", { name: "Inside", firstDate: "2026-10-01", lastDate: "2026-10-31" }],
      ["enclosing another", { name: "Around", firstDate: "2026-01-01", lastDate: "2027-12-31" }],
    ])("that overlaps another in the School, by %s, is refused as a conflict", async (_case, overlapping) => {
      const world = await arrange();
      await create(world.alice);
      const before = await stored();

      const response = await world.alice.post("/academic-years", overlapping);

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ status: "conflict", conflict: "academic_year_overlap" });
      expect(await stored()).toEqual(before);
      expect(await trailOf(world.alice, "academic_year.created")).toHaveLength(1);
    });

    it("may share its dates with a year in another School", async () => {
      const world = await arrange();
      await create(world.alice);

      expect((await world.bob.post("/academic-years", YEAR)).status).toBe(201);
      expect(await yearsOf(world.alice)).toHaveLength(1);
      expect(await yearsOf(world.bob)).toHaveLength(1);
    });

    it.each([
      ["a last date before its first", { ...YEAR, lastDate: "2026-08-31" }],
      ["a date that does not exist", { ...YEAR, lastDate: "2027-02-30" }],
      ["a date with a time", { ...YEAR, firstDate: "2026-09-01T00:00:00Z" }],
      ["a date written another way", { ...YEAR, firstDate: "09/01/2026" }],
      ["a date that is not text", { ...YEAR, firstDate: 20260901 }],
      ["no first date", { name: YEAR.name, lastDate: YEAR.lastDate }],
      ["no last date", { name: YEAR.name, firstDate: YEAR.firstDate }],
      ["no name", { firstDate: YEAR.firstDate, lastDate: YEAR.lastDate }],
      ["a blank name", { ...YEAR, name: "   " }],
      ["a name too long to be one", { ...YEAR, name: "x".repeat(201) }],
      ["Terms given at creation", { ...YEAR, terms: HALVES }],
      ["a field there is no such thing as", { ...YEAR, colour: "blue" }],
      ["a body that is not an object", [YEAR]],
    ])("is not created from %s", async (_case, body) => {
      const world = await arrange();

      const response = await world.alice.post("/academic-years", body);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ status: "invalid_request" });
      expect(await stored()).toEqual({ years: [], terms: [] });
    });

    it("is renamed, recording its values before and after", async () => {
      const world = await arrange();
      const year = await create(world.alice);

      const response = await world.alice.patch(`/academic-years/${year.id}`, { name: "Year of the Owl" });

      expect(response.status).toBe(200);
      expect((response.body as { academicYear: AcademicYear }).academicYear).toEqual({
        ...year,
        name: "Year of the Owl",
      });
      expect(await trailOf(world.alice, "academic_year.changed")).toEqual([
        expect.objectContaining({
          actorPersonId: world.aliceId,
          target: { type: "academic_year", id: year.id },
          before: YEAR_VALUES,
          after: { ...YEAR_VALUES, name: "Year of the Owl" },
        }),
      ]);
    });

    it("has its bounds changed while it has no Terms", async () => {
      const world = await arrange();
      const year = await create(world.alice);

      const response = await world.alice.patch(`/academic-years/${year.id}`, {
        firstDate: "2026-08-25",
        lastDate: "2027-06-20",
        reason: "Start a week early",
      });

      expect(response.status).toBe(200);
      expect(await yearsOf(world.alice)).toEqual([
        { ...year, firstDate: "2026-08-25", lastDate: "2027-06-20", instructionalDays: expect.any(Array) },
      ]);
      expect(await trailOf(world.alice, "academic_year.changed")).toEqual([
        expect.objectContaining({
          reason: "Start a week early",
          before: YEAR_VALUES,
          after: { ...YEAR_VALUES, firstDate: "2026-08-25", lastDate: "2027-06-20" },
        }),
      ]);
    });

    it("cannot have its bounds changed to overlap another year", async () => {
      const world = await arrange();
      await create(world.alice);
      const next = await create(world.alice, { name: "2027–28", firstDate: "2027-09-01", lastDate: "2028-06-30" });
      const before = await stored();

      const response = await world.alice.patch(`/academic-years/${next.id}`, { firstDate: "2027-06-01" });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ status: "conflict", conflict: "academic_year_overlap" });
      expect(await stored()).toEqual(before);
      expect(await trailOf(world.alice, "academic_year.changed")).toEqual([]);
    });

    it("cannot have its first date moved past its last", async () => {
      const world = await arrange();
      const year = await create(world.alice);

      const response = await world.alice.patch(`/academic-years/${year.id}`, { firstDate: "2027-07-01" });

      expect(response.status).toBe(400);
      expect(await yearsOf(world.alice)).toEqual([year]);
    });

    it("records nothing for a change stating what it already holds", async () => {
      const world = await arrange();
      const year = await createDivided(world.alice);

      const response = await world.alice.patch(`/academic-years/${year.id}`, { ...YEAR, terms: year.terms });

      expect(response.status).toBe(200);
      expect((response.body as { academicYear: AcademicYear }).academicYear).toEqual(year);
      expect(await trailOf(world.alice, "academic_year.changed", "term.changed", "term.deleted")).toEqual([]);
      expect(await trailOf(world.alice, "term.created")).toHaveLength(2);
    });

    it("is deleted while it has no Terms, recording what it held", async () => {
      const world = await arrange();
      const year = await create(world.alice);

      const response = await world.alice.delete(`/academic-years/${year.id}`, { reason: "Entered by mistake" });

      expect(response.status).toBe(200);
      expect(await yearsOf(world.alice)).toEqual([]);
      expect(await trailOf(world.alice, "academic_year.deleted")).toEqual([
        expect.objectContaining({
          actorPersonId: world.aliceId,
          target: { type: "academic_year", id: year.id },
          reason: "Entered by mistake",
          before: YEAR_VALUES,
          after: null,
        }),
      ]);
    });

    it("is not deleted while it has Terms, naming them as what depends on it", async () => {
      const world = await arrange();
      const year = await createDivided(world.alice);
      const before = await stored();

      const response = await world.alice.delete(`/academic-years/${year.id}`);

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ status: "conflict", conflict: "dependent", dependent: "term" });
      expect(await stored()).toEqual(before);
      expect(await trailOf(world.alice, "academic_year.deleted")).toEqual([]);
    });

    it("deleted while a change to it waits is refused as a year that does not exist", async () => {
      const world = await arrange();
      const year = await create(world.alice);
      const holder = await server().ownerDatabase.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM app.academic_year WHERE id = $1 FOR UPDATE", [year.id]);
        const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const waiting = world.alice.patch(`/academic-years/${year.id}`, { name: "Renamed" });
        await expect
          .poll(async () => {
            const blocked = await server().ownerDatabase.query(
              "SELECT 1 FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))",
              [rows[0]!.pid],
            );
            return blocked.rowCount;
          })
          .toBe(1);
        await holder.query("DELETE FROM app.academic_year WHERE id = $1", [year.id]);
        await holder.query("COMMIT");

        const response = await waiting;
        const refusal = await world.alice.patch(`/academic-years/${ABSENT_ID}`, { name: "Renamed" });

        expect(observable(response)).toEqual(observable(refusal));
      } finally {
        holder.release();
      }
    });

    it("is not created or changed when its Audit record cannot be written", async () => {
      const world = await arrange();
      const year = await create(world.alice);
      const before = await stored();
      await server().ownerDatabase.query("REVOKE INSERT ON app.audit_record FROM schoolgrid_app");

      await world.alice.post("/academic-years", { name: "2027–28", firstDate: "2027-09-01", lastDate: "2028-06-30" });
      await world.alice.patch(`/academic-years/${year.id}`, { name: "Renamed", terms: HALVES });
      await world.alice.delete(`/academic-years/${year.id}`);

      expect(await stored()).toEqual(before);
    });
  });

  describe("its Terms", () => {
    it("divide the year when they cover it exactly, and are listed in order", async () => {
      const world = await arrange();
      const year = await create(world.alice);

      // Sent out of order: the order is the dates', not the request's.
      const response = await world.alice.patch(`/academic-years/${year.id}`, { terms: [HALVES[1], HALVES[0]] });

      expect(response.status).toBe(200);
      const { academicYear } = response.body as { academicYear: AcademicYear };
      expect(academicYear.terms).toEqual(HALVES.map((term) => ({ id: expect.any(String), ...term })));
      expect(await yearsOf(world.alice)).toEqual([academicYear]);
    });

    it("may be a single Term spanning the whole year", async () => {
      const world = await arrange();
      const year = await create(world.alice);

      const response = await world.alice.patch(`/academic-years/${year.id}`, {
        terms: [{ name: "Whole year", firstDate: YEAR.firstDate, lastDate: YEAR.lastDate }],
      });

      expect(response.status).toBe(200);
    });

    it("record each Term created, against the year it belongs to", async () => {
      const world = await arrange();
      const year = await create(world.alice);

      const response = await world.alice.patch(`/academic-years/${year.id}`, { terms: HALVES, reason: "Two halves" });
      const [fall, spring] = (response.body as { academicYear: AcademicYear }).academicYear.terms;

      expect(await trailOf(world.alice, "term.created")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actorPersonId: world.aliceId,
            target: { type: "term", id: fall!.id },
            reason: "Two halves",
            before: null,
            after: { academicYearId: year.id, ...HALVES[0] },
          }),
          expect.objectContaining({
            target: { type: "term", id: spring!.id },
            after: { academicYearId: year.id, ...HALVES[1] },
          }),
        ]),
      );
      expect(await trailOf(world.alice, "term.created")).toHaveLength(2);
    });

    it.each([
      [
        "that overlap",
        [
          { name: "Fall", firstDate: "2026-09-01", lastDate: "2027-01-16" },
          { name: "Spring", firstDate: "2027-01-16", lastDate: "2027-06-30" },
        ],
        "term_overlap",
      ],
      [
        "that leave a gap between them",
        [
          { name: "Fall", firstDate: "2026-09-01", lastDate: "2027-01-14" },
          { name: "Spring", firstDate: "2027-01-16", lastDate: "2027-06-30" },
        ],
        "term_gap",
      ],
      [
        "that begin after the year does",
        [
          { name: "Fall", firstDate: "2026-09-02", lastDate: "2027-01-15" },
          { name: "Spring", firstDate: "2027-01-16", lastDate: "2027-06-30" },
        ],
        "term_gap",
      ],
      [
        "that end before the year does",
        [
          { name: "Fall", firstDate: "2026-09-01", lastDate: "2027-01-15" },
          { name: "Spring", firstDate: "2027-01-16", lastDate: "2027-06-29" },
        ],
        "term_gap",
      ],
      [
        "one of which begins before the year",
        [
          { name: "Fall", firstDate: "2026-08-31", lastDate: "2027-01-15" },
          { name: "Spring", firstDate: "2027-01-16", lastDate: "2027-06-30" },
        ],
        "term_outside_academic_year",
      ],
      [
        "one of which ends after the year",
        [
          { name: "Fall", firstDate: "2026-09-01", lastDate: "2027-01-15" },
          { name: "Spring", firstDate: "2027-01-16", lastDate: "2027-07-01" },
        ],
        "term_outside_academic_year",
      ],
    ])("%s are refused as a conflict, changing nothing", async (_case, proposed, conflict) => {
      const world = await arrange();
      const year = await createDivided(world.alice);
      const before = await stored();

      const response = await world.alice.patch(`/academic-years/${year.id}`, {
        name: "Renamed with them",
        terms: proposed,
      });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ status: "conflict", conflict });
      expect(await stored()).toEqual(before);
      expect(await trailOf(world.alice, "academic_year.changed", "term.created", "term.changed")).toHaveLength(2);
    });

    it("move the boundary between two adjacent Terms in one request, recording each Term's change", async () => {
      const world = await arrange();
      const year = await createDivided(world.alice);
      const [fall, spring] = year.terms as [Term, Term];

      const response = await world.alice.patch(`/academic-years/${year.id}`, {
        terms: [
          { ...fall, lastDate: "2027-01-22" },
          { ...spring, firstDate: "2027-01-23" },
        ],
      });

      expect(response.status).toBe(200);
      expect((await yearsOf(world.alice))[0]!.terms).toEqual([
        { ...fall, lastDate: "2027-01-22" },
        { ...spring, firstDate: "2027-01-23" },
      ]);
      expect(await trailOf(world.alice, "term.changed")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            target: { type: "term", id: fall.id },
            before: { academicYearId: year.id, ...HALVES[0] },
            after: { academicYearId: year.id, ...HALVES[0], lastDate: "2027-01-22" },
          }),
          expect.objectContaining({
            target: { type: "term", id: spring.id },
            before: { academicYearId: year.id, ...HALVES[1] },
            after: { academicYearId: year.id, ...HALVES[1], firstDate: "2027-01-23" },
          }),
        ]),
      );
      expect(await trailOf(world.alice, "term.changed")).toHaveLength(2);
    });

    it("move the boundary the other way too, whichever Term the request names first", async () => {
      const world = await arrange();
      const year = await createDivided(world.alice);
      const [fall, spring] = year.terms as [Term, Term];

      const response = await world.alice.patch(`/academic-years/${year.id}`, {
        terms: [
          { ...spring, firstDate: "2027-01-09" },
          { ...fall, lastDate: "2027-01-08" },
        ],
      });

      expect(response.status).toBe(200);
      expect(terms((await yearsOf(world.alice))[0]!)).toEqual([
        { ...HALVES[0], lastDate: "2027-01-08" },
        { ...HALVES[1], firstDate: "2027-01-09" },
      ]);
    });

    it("are renamed, recording only the Term that changed", async () => {
      const world = await arrange();
      const year = await createDivided(world.alice);
      const [fall, spring] = year.terms as [Term, Term];

      const response = await world.alice.patch(`/academic-years/${year.id}`, {
        terms: [{ ...fall, name: "Autumn" }, spring],
      });

      expect(response.status).toBe(200);
      expect((await yearsOf(world.alice))[0]!.terms).toEqual([{ ...fall, name: "Autumn" }, spring]);
      expect(await trailOf(world.alice, "term.changed")).toEqual([
        expect.objectContaining({
          target: { type: "term", id: fall.id },
          before: { academicYearId: year.id, ...HALVES[0] },
          after: { academicYearId: year.id, ...HALVES[0], name: "Autumn" },
        }),
      ]);
    });

    it("are deleted by being left out, while the rest still cover the year", async () => {
      const world = await arrange();
      const year = await createDivided(world.alice);
      const [fall, spring] = year.terms as [Term, Term];

      const response = await world.alice.patch(`/academic-years/${year.id}`, {
        terms: [{ ...fall, lastDate: YEAR.lastDate }],
      });

      expect(response.status).toBe(200);
      expect((await yearsOf(world.alice))[0]!.terms).toEqual([{ ...fall, lastDate: YEAR.lastDate }]);
      expect(await trailOf(world.alice, "term.deleted")).toEqual([
        expect.objectContaining({
          target: { type: "term", id: spring.id },
          before: { academicYearId: year.id, ...HALVES[1] },
          after: null,
        }),
      ]);
    });

    it("may all be deleted at once, leaving the year undivided so it can be deleted", async () => {
      const world = await arrange();
      const year = await createDivided(world.alice);

      const cleared = await world.alice.patch(`/academic-years/${year.id}`, { terms: [] });
      const deleted = await world.alice.delete(`/academic-years/${year.id}`);

      expect([cleared.status, deleted.status]).toEqual([200, 200]);
      expect(await trailOf(world.alice, "term.deleted")).toHaveLength(2);
      expect(await yearsOf(world.alice)).toEqual([]);
    });

    it("are replaced wholesale when the year is divided afresh", async () => {
      const world = await arrange();
      const year = await createDivided(world.alice);
      const thirds = [
        { name: "Fall", firstDate: "2026-09-01", lastDate: "2026-11-30" },
        { name: "Winter", firstDate: "2026-12-01", lastDate: "2027-03-15" },
        { name: "Spring", firstDate: "2027-03-16", lastDate: "2027-06-30" },
      ];

      const response = await world.alice.patch(`/academic-years/${year.id}`, { terms: thirds });

      expect(response.status).toBe(200);
      expect(terms((await yearsOf(world.alice))[0]!)).toEqual(thirds);
      expect(await trailOf(world.alice, "term.deleted")).toHaveLength(2);
      expect(await trailOf(world.alice, "term.created")).toHaveLength(5);
    });

    it("are not deleted while one has Class Offerings, naming them, though their bounds may still move", async () => {
      const world = await arrange();
      const year = await createDivided(world.alice);
      const [fall, spring] = year.terms;
      const course = await world.alice.post("/courses", { name: "Algebra I" });
      const offered = await world.alice.post("/class-offerings", {
        courseId: (course.body as { course: { id: string } }).course.id,
        termId: fall!.id,
      });
      expect([course.status, offered.status]).toEqual([201, 201]);
      const before = await stored();

      // Leaving Fall out deletes it, whether its dates go to Spring or to a new Term.
      const merged = await world.alice.patch(`/academic-years/${year.id}`, {
        terms: [{ id: spring!.id, name: "Whole year", firstDate: YEAR.firstDate, lastDate: YEAR.lastDate }],
      });
      const replaced = await world.alice.patch(`/academic-years/${year.id}`, { terms: HALVES });

      for (const response of [merged, replaced]) {
        expect(response.status).toBe(409);
        expect(response.body).toEqual({ status: "conflict", conflict: "dependent", dependent: "class_offering" });
      }
      expect(await stored()).toEqual(before);
      expect(await trailOf(world.alice, "term.deleted", "term.created", "term.changed")).toHaveLength(2);

      const moved = await world.alice.patch(`/academic-years/${year.id}`, {
        terms: [
          { id: fall!.id, name: "Fall", firstDate: "2026-09-01", lastDate: "2027-01-31" },
          { id: spring!.id, name: "Spring", firstDate: "2027-02-01", lastDate: "2027-06-30" },
        ],
      });
      expect(moved.status).toBe(200);
    });

    it("hold the year's bounds: shrinking it past them strands them, and growing it leaves a gap", async () => {
      const world = await arrange();
      const year = await createDivided(world.alice);
      const before = await stored();

      const shrunk = await world.alice.patch(`/academic-years/${year.id}`, { lastDate: "2027-06-15" });
      const grown = await world.alice.patch(`/academic-years/${year.id}`, { firstDate: "2026-08-15" });

      expect(shrunk.status).toBe(409);
      expect(shrunk.body).toEqual({ status: "conflict", conflict: "dependent", dependent: "term" });
      expect(grown.status).toBe(409);
      expect(grown.body).toEqual({ status: "conflict", conflict: "term_gap" });
      expect(await stored()).toEqual(before);
    });

    it("move with the year's bounds when both change in one request", async () => {
      const world = await arrange();
      const year = await createDivided(world.alice);
      const [fall, spring] = year.terms as [Term, Term];

      const response = await world.alice.patch(`/academic-years/${year.id}`, {
        lastDate: "2027-06-15",
        terms: [fall, { ...spring, lastDate: "2027-06-15" }],
      });

      expect(response.status).toBe(200);
      expect(await yearsOf(world.alice)).toEqual([
        {
          ...year,
          lastDate: "2027-06-15",
          instructionalDays: expect.any(Array),
          terms: [fall, { ...spring, lastDate: "2027-06-15" }],
        },
      ]);
    });

    it.each([
      ["a Term with a blank name", [{ ...HALVES[0], name: "" }, HALVES[1]]],
      ["a Term whose last date is before its first", [{ ...HALVES[0], lastDate: "2026-08-01" }, HALVES[1]]],
      ["a Term with a date that does not exist", [{ ...HALVES[0], lastDate: "2027-01-32" }, HALVES[1]]],
      ["a Term with a field there is no such thing as", [{ ...HALVES[0], ordinal: 1 }, HALVES[1]]],
      ["a Term that is not an object", ["Fall", HALVES[1]]],
      ["Terms that are not a list", { fall: HALVES[0] }],
      ["a Term named by an identifier that is not one of this year's", [{ id: ABSENT_ID, ...HALVES[0] }, HALVES[1]]],
      ["far more Terms than any year has", Array.from({ length: 101 }, () => HALVES[0])],
    ])("are not changed by %s", async (_case, proposed) => {
      const world = await arrange();
      const year = await create(world.alice);

      const response = await world.alice.patch(`/academic-years/${year.id}`, { terms: proposed });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ status: "invalid_request" });
      expect(await yearsOf(world.alice)).toEqual([year]);
    });

    it("of another year cannot be named in this one's", async () => {
      const world = await arrange();
      const first = await createDivided(world.alice);
      const second = await create(world.alice, { name: "2027–28", firstDate: "2027-09-01", lastDate: "2028-06-30" });
      const before = await stored();

      const response = await world.alice.patch(`/academic-years/${second.id}`, {
        terms: [{ ...first.terms[0]!, firstDate: "2027-09-01", lastDate: "2028-06-30" }],
      });

      expect(response.status).toBe(400);
      expect(await stored()).toEqual(before);
    });

    it("cannot overlap one another even when written directly", async () => {
      const world = await arrange();
      const year = await create(world.alice);

      await expect(
        server().database.query(
          `INSERT INTO app.term (school_id, academic_year_id, name, first_date, last_date)
           VALUES ($1, $2, 'One', '2026-09-01', '2027-01-15'), ($1, $2, 'Two', '2027-01-15', '2027-06-30')`,
          [world.northsideId, year.id],
        ),
      ).rejects.toThrow(/term_no_overlap/);
    });

    it("cannot belong to another School's year even when written directly", async () => {
      const world = await arrange();
      const year = await create(world.alice);

      await expect(
        server().database.query(
          `INSERT INTO app.term (school_id, academic_year_id, name, first_date, last_date)
           VALUES ($1, $2, 'Stray', '2026-09-01', '2027-06-30')`,
          [world.westbrookId, year.id],
        ),
      ).rejects.toThrow(/foreign key/);
    });
  });

  describe("Academic Years in the database", () => {
    it("cannot overlap in one School even when written directly", async () => {
      const world = await arrange();
      await create(world.alice);

      await expect(
        server().database.query(
          `INSERT INTO app.academic_year (school_id, name, first_date, last_date)
           VALUES ($1, 'Overlapping', '2027-06-30', '2028-06-30')`,
          [world.northsideId],
        ),
      ).rejects.toThrow(/academic_year_no_overlap/);
    });
  });

  describe("the School's timezone", () => {
    async function settingsOf(admin: TestClient) {
      const response = await admin.get("/settings");
      expect(response.status).toBe(200);
      return (response.body as { settings: { timezone: string; timezoneFixed: boolean } }).settings;
    }

    it("may change while the School has no Academic Year", async () => {
      const world = await arrange();

      expect(await settingsOf(world.alice)).toEqual({ timezone: "America/New_York", timezoneFixed: false });
      expect((await world.alice.patch("/settings", { timezone: "America/Chicago" })).status).toBe(200);
    });

    it("is fixed once the School's first Academic Year exists, and says so", async () => {
      const world = await arrange();
      await create(world.alice);

      const response = await world.alice.patch("/settings", { timezone: "America/Chicago" });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ status: "conflict", conflict: "timezone_fixed" });
      expect(await settingsOf(world.alice)).toEqual({ timezone: "America/New_York", timezoneFixed: true });
      expect(await trailOf(world.alice, "school.settings_changed")).toEqual([]);
    });

    it("still answers a change stating the timezone the School already has", async () => {
      const world = await arrange();
      await create(world.alice);

      const response = await world.alice.patch("/settings", { timezone: "America/New_York" });

      expect(response.status).toBe(200);
    });

    it("is fixed even against a direct write", async () => {
      const world = await arrange();
      await create(world.alice);

      for (const database of [server().database, server().ownerDatabase]) {
        await expect(
          database.query("UPDATE app.school SET timezone = 'America/Chicago' WHERE id = $1", [world.northsideId]),
        ).rejects.toThrow(/timezone is fixed/);
      }
    });

    it("stays fixed once the School's only Academic Year is deleted, even against a direct write", async () => {
      const world = await arrange();
      const year = await create(world.alice);
      expect((await world.alice.delete(`/academic-years/${year.id}`)).status).toBe(200);

      const response = await world.alice.patch("/settings", { timezone: "America/Chicago" });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ status: "conflict", conflict: "timezone_fixed" });
      expect(await settingsOf(world.alice)).toEqual({ timezone: "America/New_York", timezoneFixed: true });
      for (const database of [server().database, server().ownerDatabase]) {
        await expect(
          database.query("UPDATE app.school SET timezone = 'America/Chicago' WHERE id = $1", [world.northsideId]),
        ).rejects.toThrow(/timezone is fixed/);
      }
      await expect(
        server().database.query("UPDATE app.school SET timezone_fixed = false WHERE id = $1", [world.northsideId]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        server().ownerDatabase.query("UPDATE app.school SET timezone_fixed = false WHERE id = $1", [world.northsideId]),
      ).rejects.toThrow(/timezone is fixed/);
    });

    it("of another School stays free to change", async () => {
      const world = await arrange();
      await create(world.alice);

      expect((await world.bob.patch("/settings", { timezone: "Asia/Tokyo" })).status).toBe(200);
    });
  });

  describe("outside the caller's reach is the standard refusal", () => {
    async function arrangeWithYear() {
      const world = await arrangeWithCallers();
      const year = await createDivided(world.alice);
      return { world, year };
    }

    const attempts = [
      ["listing", (c: TestClient) => c.get("/academic-years")],
      ["creating", (c: TestClient) => c.post("/academic-years", { ...YEAR, name: "Another", firstDate: "2027-09-01", lastDate: "2028-06-30" })],
      ["creating from a malformed body", (c: TestClient) => c.post("/academic-years", { name: 5 })],
      ["renaming", (c: TestClient, id: string) => c.patch(`/academic-years/${id}`, { name: "Taken over" })],
      ["dividing into Terms", (c: TestClient, id: string) => c.patch(`/academic-years/${id}`, { terms: [] })],
      ["changing from a malformed body", (c: TestClient, id: string) => c.patch(`/academic-years/${id}`, { terms: 5 })],
      ["deleting", (c: TestClient, id: string) => c.delete(`/academic-years/${id}`)],
    ] as const;

    const callers = [
      ["a Faculty member", (w: WithCallers) => w.frankie],
      ["a Student", (w: WithCallers) => w.sam],
      ["a Guardian", (w: WithCallers) => w.gina],
      ["another School's Administrator", (w: WithCallers) => w.bob.inSchool(w.northsideId)],
      ["a Platform Administrator", (w: WithCallers) => w.pat],
      ["a caller with no session", (w: WithCallers) => server().client.inSchool(w.northsideId)],
    ] as const;

    // One world per caller, every action tried within it: each world costs a
    // fresh database and a Person in every role.
    it.each(callers)(
      "refuses %s every action exactly as an absent Person is refused, changing nothing",
      async (_caller, as) => {
        const { world, year } = await arrangeWithYear();
        const before = await stored();
        const absent = await world.sam.get(`/persons/${ABSENT_ID}`);
        expect(absent.status).not.toBe(200);

        const answered: string[] = [];
        for (const [what, attempt] of attempts) {
          const refused = await attempt(as(world), year.id);
          if (!isDeepStrictEqual(observable(refused), observable(absent))) {
            answered.push(`${what} answered ${refused.status}`);
          }
        }

        expect(answered).toEqual([]);
        expect(await stored()).toEqual(before);
      },
    );

    it.each([
      ["renaming", (c: TestClient, id: string) => c.patch(`/academic-years/${id}`, { name: "Renamed" })],
      ["deleting", (c: TestClient, id: string) => c.delete(`/academic-years/${id}`)],
    ] as const)("refuses %s a year that does not exist, or is another School's, identically", async (_what, attempt) => {
      const { world, year } = await arrangeWithYear();
      const before = await stored();

      const absent = await attempt(world.alice, ABSENT_ID);
      const malformed = await attempt(world.alice, "not-an-identifier");
      const elsewhere = await attempt(world.bob, year.id);
      const refusal = await world.sam.get(`/persons/${ABSENT_ID}`);

      for (const response of [absent, malformed, elsewhere]) {
        expect(observable(response)).toEqual(observable(refusal));
      }
      expect(await stored()).toEqual(before);
    });

    it("records a refused change with its true reason", async () => {
      const { world, year } = await arrangeWithYear();

      await world.frankie.patch(`/academic-years/${year.id}`, { name: "Mine now" });
      await world.bob.delete(`/academic-years/${year.id}`);

      expect(await trailOf(world.alice, "access.refused")).toEqual([
        expect.objectContaining({ reason: "forbidden", target: { type: "academic_year", id: year.id } }),
      ]);
      expect(await trailOf(world.bob, "access.refused")).toEqual([
        expect.objectContaining({ reason: "outside-school", target: { type: "academic_year", id: year.id } }),
      ]);
    });
  });
});
