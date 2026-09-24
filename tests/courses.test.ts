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

interface Course {
  id: string;
  name: string;
  code: string | null;
}

interface Term {
  id: string;
  name: string;
  firstDate: string;
  lastDate: string;
}

interface ClassOffering {
  id: string;
  label: string | null;
  course: Course;
  term: Term & { academicYear: { id: string; name: string } };
}

/** A year running from September to June, divided into two Terms. */
const YEAR = { name: "2026–27", firstDate: "2026-09-01", lastDate: "2027-06-30" };
const HALVES = [
  { name: "Fall", firstDate: "2026-09-01", lastDate: "2027-01-15" },
  { name: "Spring", firstDate: "2027-01-16", lastDate: "2027-06-30" },
];

const ALGEBRA = { name: "Algebra I", code: "MATH-101" };

describe("Courses and Class Offerings", () => {
  const server = useTestServer();

  interface World {
    northsideId: string;
    westbrookId: string;
    aliceId: string;
    /** Alice: Northside's School Administrator. */
    alice: TestClient;
    /** Bob: Westbrook's School Administrator, and nothing at Northside. */
    bob: TestClient;
    /** Northside's year, divided into Fall and Spring. */
    fall: Term;
    spring: Term;
    /** Westbrook's own Term, for reaching across Schools. */
    westbrookTerm: Term;
  }

  /** Everyone else a refusal is tried as, arranged only where one is. */
  interface WithCallers extends World {
    frankie: TestClient;
    sam: TestClient;
    gina: TestClient;
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
    const alice = (await server().sessionFor(aliceAccount)).inSchool(northside.school.id);
    const bob = (await server().sessionFor(bobAccount)).inSchool(westbrook.school.id);
    const [fall, spring] = await divide(alice);
    const [westbrookTerm] = await divide(bob);
    return {
      northsideId: northside.school.id,
      westbrookId: westbrook.school.id,
      aliceId: northside.schoolAdministrator.id,
      alice,
      bob,
      fall: fall!,
      spring: spring!,
      westbrookTerm: westbrookTerm!,
    };
  }

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

  /** Creates YEAR divided into HALVES, returning its Terms. */
  async function divide(admin: TestClient): Promise<Term[]> {
    const created = await admin.post("/academic-years", YEAR);
    expect(created.status).toBe(201);
    const { id } = (created.body as { academicYear: { id: string } }).academicYear;
    const divided = await admin.patch(`/academic-years/${id}`, { terms: HALVES });
    expect(divided.status).toBe(200);
    return (divided.body as { academicYear: { terms: Term[] } }).academicYear.terms;
  }

  async function createCourse(admin: TestClient, course: object = ALGEBRA): Promise<Course> {
    const response = await admin.post("/courses", course);
    expect(response.status).toBe(201);
    return (response.body as { course: Course }).course;
  }

  async function offer(admin: TestClient, offering: object): Promise<ClassOffering> {
    const response = await admin.post("/class-offerings", offering);
    expect(response.status).toBe(201);
    return (response.body as { classOffering: ClassOffering }).classOffering;
  }

  async function coursesOf(admin: TestClient): Promise<Course[]> {
    const response = await admin.get("/courses");
    expect(response.status).toBe(200);
    return (response.body as { courses: Course[] }).courses;
  }

  async function offeringsOf(admin: TestClient): Promise<ClassOffering[]> {
    const response = await admin.get("/class-offerings");
    expect(response.status).toBe(200);
    return (response.body as { classOfferings: ClassOffering[] }).classOfferings;
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
    const courses = await server().ownerDatabase.query(
      "SELECT id, school_id, name, code FROM app.course ORDER BY id",
    );
    const offerings = await server().ownerDatabase.query(
      "SELECT id, school_id, course_id, term_id, label FROM app.class_offering ORDER BY id",
    );
    const terms = await server().ownerDatabase.query("SELECT id, name, first_date::text FROM app.term ORDER BY id");
    return { courses: courses.rows, offerings: offerings.rows, terms: terms.rows };
  }

  describe("a Course", () => {
    it("is created with a name and an optional code, listed by name, and recorded", async () => {
      const world = await arrange();

      const uncoded = await createCourse(world.alice, { name: "Zoology" });
      const response = await world.alice.post("/courses", { ...ALGEBRA, reason: "New catalogue" });

      expect(response.status).toBe(201);
      const { course } = response.body as { course: Course };
      expect(course).toEqual({ id: expect.any(String), ...ALGEBRA });
      expect(uncoded).toEqual({ id: expect.any(String), name: "Zoology", code: null });
      expect(await coursesOf(world.alice)).toEqual([course, uncoded]);
      expect(await coursesOf(world.bob)).toEqual([]);
      expect(await trailOf(world.alice, "course.created")).toEqual([
        expect.objectContaining({
          actorPersonId: world.aliceId,
          target: { type: "course", id: course.id },
          reason: "New catalogue",
          before: null,
          after: ALGEBRA,
        }),
        expect.objectContaining({ after: { name: "Zoology", code: null } }),
      ]);
    });

    it("whose name or code another Course has, ignoring letter case, is refused as a conflict", async () => {
      const world = await arrange();
      await createCourse(world.alice);
      const before = await stored();

      const sameName = await world.alice.post("/courses", { name: "ALGEBRA i" });
      const sameCode = await world.alice.post("/courses", { name: "Algebra One", code: "math-101" });

      expect(sameName.status).toBe(409);
      expect(sameName.body).toEqual({ status: "conflict", conflict: "course_name_taken" });
      expect(sameCode.status).toBe(409);
      expect(sameCode.body).toEqual({ status: "conflict", conflict: "course_code_taken" });
      expect(await stored()).toEqual(before);
      // Another School's catalogue is its own.
      await createCourse(world.bob);
    });

    it("is renamed and recoded, recording its values before and after", async () => {
      const world = await arrange();
      const course = await createCourse(world.alice);

      const renamed = await world.alice.patch(`/courses/${course.id}`, { name: "Algebra 1", reason: "Style" });
      const uncoded = await world.alice.patch(`/courses/${course.id}`, { code: null });
      // Its own name, told in another case, is still its own.
      const recased = await world.alice.patch(`/courses/${course.id}`, { name: "ALGEBRA 1" });

      expect([renamed.status, uncoded.status, recased.status]).toEqual([200, 200, 200]);
      expect(recased.body).toEqual({ course: { id: course.id, name: "ALGEBRA 1", code: null } });
      expect(await trailOf(world.alice, "course.changed")).toEqual([
        expect.objectContaining({ before: { name: "Algebra 1", code: null }, after: { name: "ALGEBRA 1", code: null } }),
        expect.objectContaining({ before: { name: "Algebra 1", code: "MATH-101" }, after: { name: "Algebra 1", code: null } }),
        expect.objectContaining({
          actorPersonId: world.aliceId,
          target: { type: "course", id: course.id },
          reason: "Style",
          before: ALGEBRA,
          after: { name: "Algebra 1", code: "MATH-101" },
        }),
      ]);
    });

    it("cannot be renamed to another Course's name, and records nothing for a change stating what it holds", async () => {
      const world = await arrange();
      const course = await createCourse(world.alice);
      await createCourse(world.alice, { name: "Biology" });
      const before = await stored();

      const taken = await world.alice.patch(`/courses/${course.id}`, { name: "biology" });
      const unchanged = await world.alice.patch(`/courses/${course.id}`, ALGEBRA);

      expect(taken.status).toBe(409);
      expect(taken.body).toEqual({ status: "conflict", conflict: "course_name_taken" });
      expect(unchanged.status).toBe(200);
      expect(await stored()).toEqual(before);
      expect(await trailOf(world.alice, "course.changed")).toEqual([]);
    });

    it("is deleted while it is not offered, recording what it held", async () => {
      const world = await arrange();
      const course = await createCourse(world.alice);

      const response = await world.alice.delete(`/courses/${course.id}`, { reason: "Entered by mistake" });

      expect(response.status).toBe(200);
      expect(await coursesOf(world.alice)).toEqual([]);
      expect(await trailOf(world.alice, "course.deleted")).toEqual([
        expect.objectContaining({
          target: { type: "course", id: course.id },
          reason: "Entered by mistake",
          before: ALGEBRA,
          after: null,
        }),
      ]);
    });

    it("is not deleted while it is offered, naming Class Offerings as what depends on it", async () => {
      const world = await arrange();
      const course = await createCourse(world.alice);
      await offer(world.alice, { courseId: course.id, termId: world.fall.id });
      const before = await stored();

      const response = await world.alice.delete(`/courses/${course.id}`);

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ status: "conflict", conflict: "dependent", dependent: "class_offering" });
      expect(await stored()).toEqual(before);
      expect(await trailOf(world.alice, "course.deleted")).toEqual([]);
    });

    it("is refused a malformed name or code", async () => {
      const world = await arrange();
      const course = await createCourse(world.alice);
      const before = await stored();

      const responses = [
        await world.alice.post("/courses", { name: " " }),
        await world.alice.post("/courses", { name: "Chemistry", code: "" }),
        await world.alice.post("/courses", { code: "CHEM" }),
        await world.alice.patch(`/courses/${course.id}`, { name: null }),
        await world.alice.patch(`/courses/${course.id}`, { colour: "red" }),
      ];

      expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400]);
      expect(await stored()).toEqual(before);
    });
  });

  describe("a Class Offering", () => {
    it("offers a Course in a Term, is listed, opens by itself, and is recorded", async () => {
      const world = await arrange();
      const course = await createCourse(world.alice);

      const response = await world.alice.post("/class-offerings", {
        courseId: course.id,
        termId: world.fall.id,
        reason: "Timetabling",
      });

      expect(response.status).toBe(201);
      const { classOffering } = response.body as { classOffering: ClassOffering };
      expect(classOffering).toEqual({
        id: expect.any(String),
        label: null,
        course,
        term: { ...world.fall, academicYear: { id: expect.any(String), name: YEAR.name } },
      });
      expect(await offeringsOf(world.alice)).toEqual([classOffering]);
      // Read by itself, it names its Teaching assignments too: none yet.
      expect((await world.alice.get(`/class-offerings/${classOffering.id}`)).body).toEqual({
        classOffering: { ...classOffering, teachingAssignments: [] },
      });
      expect(await trailOf(world.alice, "class_offering.created")).toEqual([
        expect.objectContaining({
          actorPersonId: world.aliceId,
          target: { type: "class_offering", id: classOffering.id },
          reason: "Timetabling",
          before: null,
          after: { courseId: course.id, termId: world.fall.id, label: null },
        }),
      ]);
    });

    it("of one Course in one Term is told apart by labels, each unique ignoring letter case", async () => {
      const world = await arrange();
      const course = await createCourse(world.alice);
      const biology = await createCourse(world.alice, { name: "Biology" });
      const first = await offer(world.alice, { courseId: course.id, termId: world.fall.id, label: "Section A" });
      const second = await offer(world.alice, { courseId: course.id, termId: world.fall.id, label: "Section B" });
      const unlabelled = await offer(world.alice, { courseId: course.id, termId: world.fall.id });
      // The same label for another Course, or another Term, tells nothing apart.
      await offer(world.alice, { courseId: biology.id, termId: world.fall.id, label: "Section A" });
      await offer(world.alice, { courseId: course.id, termId: world.spring.id, label: "Section A" });
      const before = await stored();

      const sameLabel = await world.alice.post("/class-offerings", {
        courseId: course.id,
        termId: world.fall.id,
        label: "section a",
      });
      const secondUnlabelled = await world.alice.post("/class-offerings", { courseId: course.id, termId: world.fall.id });

      for (const response of [sameLabel, secondUnlabelled]) {
        expect(response.status).toBe(409);
        expect(response.body).toEqual({ status: "conflict", conflict: "class_offering_label_taken" });
      }
      expect(await stored()).toEqual(before);
      // Listed by Term, then Course, the unlabelled one first.
      expect((await offeringsOf(world.alice)).map((each) => [each.term.name, each.course.name, each.label])).toEqual([
        ["Fall", "Algebra I", null],
        ["Fall", "Algebra I", "Section A"],
        ["Fall", "Algebra I", "Section B"],
        ["Fall", "Biology", "Section A"],
        ["Spring", "Algebra I", "Section A"],
      ]);
      expect([first.label, second.label, unlabelled.label]).toEqual(["Section A", "Section B", null]);
    });

    it("is relabelled, recording its values before and after, but not to a label taken", async () => {
      const world = await arrange();
      const course = await createCourse(world.alice);
      const first = await offer(world.alice, { courseId: course.id, termId: world.fall.id, label: "Section A" });
      await offer(world.alice, { courseId: course.id, termId: world.fall.id, label: "Section B" });

      const relabelled = await world.alice.patch(`/class-offerings/${first.id}`, { label: "Period 1", reason: "Rename" });
      const taken = await world.alice.patch(`/class-offerings/${first.id}`, { label: "SECTION B" });
      const cleared = await world.alice.patch(`/class-offerings/${first.id}`, { label: null });
      const unchanged = await world.alice.patch(`/class-offerings/${first.id}`, { label: null });

      expect(relabelled.status).toBe(200);
      expect(taken.status).toBe(409);
      expect(taken.body).toEqual({ status: "conflict", conflict: "class_offering_label_taken" });
      expect([cleared.status, unchanged.status]).toEqual([200, 200]);
      expect((cleared.body as { classOffering: ClassOffering }).classOffering.label).toBeNull();
      const values = { courseId: course.id, termId: world.fall.id };
      expect(await trailOf(world.alice, "class_offering.changed")).toEqual([
        expect.objectContaining({ before: { ...values, label: "Period 1" }, after: { ...values, label: null } }),
        expect.objectContaining({
          actorPersonId: world.aliceId,
          target: { type: "class_offering", id: first.id },
          reason: "Rename",
          before: { ...values, label: "Section A" },
          after: { ...values, label: "Period 1" },
        }),
      ]);
    });

    it("is deleted, recording what it held, and then frees its Course and Term", async () => {
      const world = await arrange();
      const course = await createCourse(world.alice);
      const offering = await offer(world.alice, { courseId: course.id, termId: world.fall.id, label: "A" });

      const response = await world.alice.delete(`/class-offerings/${offering.id}`, { reason: "Cancelled" });

      expect(response.status).toBe(200);
      expect(await offeringsOf(world.alice)).toEqual([]);
      expect(await trailOf(world.alice, "class_offering.deleted")).toEqual([
        expect.objectContaining({
          target: { type: "class_offering", id: offering.id },
          reason: "Cancelled",
          before: { courseId: course.id, termId: world.fall.id, label: "A" },
          after: null,
        }),
      ]);
      expect((await world.alice.delete(`/courses/${course.id}`)).status).toBe(200);
    });

    it("cannot offer another School's Course or Term, which are refused as ones that do not exist", async () => {
      const world = await arrange();
      const course = await createCourse(world.alice);
      const westbrookCourse = await createCourse(world.bob);
      const before = await stored();
      const refusal = await world.alice.get(`/persons/${ABSENT_ID}`);

      const attempts = [
        await world.alice.post("/class-offerings", { courseId: westbrookCourse.id, termId: world.fall.id }),
        await world.alice.post("/class-offerings", { courseId: course.id, termId: world.westbrookTerm.id }),
        await world.alice.post("/class-offerings", { courseId: ABSENT_ID, termId: world.fall.id }),
        await world.alice.post("/class-offerings", { courseId: course.id, termId: "not-an-identifier" }),
      ];

      for (const response of attempts) {
        expect(observable(response)).toEqual(observable(refusal));
      }
      expect(await stored()).toEqual(before);
    });

    it("is refused a malformed body", async () => {
      const world = await arrange();
      const course = await createCourse(world.alice);
      const offering = await offer(world.alice, { courseId: course.id, termId: world.fall.id });
      const before = await stored();

      const responses = [
        await world.alice.post("/class-offerings", { courseId: course.id }),
        await world.alice.post("/class-offerings", { courseId: 5, termId: world.fall.id }),
        await world.alice.post("/class-offerings", { courseId: course.id, termId: world.fall.id, label: " " }),
        await world.alice.patch(`/class-offerings/${offering.id}`, { courseId: course.id }),
        await world.alice.patch(`/class-offerings/${offering.id}`, {}),
      ];

      expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400]);
      expect(await stored()).toEqual(before);
    });
  });

  describe("in the database", () => {
    it("no Class Offering refers to another School's Course or Term, even when written directly", async () => {
      const world = await arrange();
      const course = await createCourse(world.alice);
      const westbrookCourse = await createCourse(world.bob);

      for (const [courseId, termId] of [
        [westbrookCourse.id, world.fall.id],
        [course.id, world.westbrookTerm.id],
      ]) {
        await expect(
          server().database.query(
            `INSERT INTO app.class_offering (school_id, course_id, term_id) VALUES ($1, $2, $3)`,
            [world.northsideId, courseId, termId],
          ),
        ).rejects.toThrow(/foreign key/);
      }
    });

    it("nothing is created or changed when its Audit record cannot be written", async () => {
      const world = await arrange();
      const course = await createCourse(world.alice);
      const offering = await offer(world.alice, { courseId: course.id, termId: world.fall.id });
      const before = await stored();
      await server().ownerDatabase.query("REVOKE INSERT ON app.audit_record FROM schoolgrid_app");

      await world.alice.post("/courses", { name: "Biology" });
      await world.alice.patch(`/courses/${course.id}`, { name: "Renamed" });
      await world.alice.post("/class-offerings", { courseId: course.id, termId: world.spring.id });
      await world.alice.patch(`/class-offerings/${offering.id}`, { label: "Relabelled" });
      await world.alice.delete(`/class-offerings/${offering.id}`);

      expect(await stored()).toEqual(before);
    });
  });

  describe("outside the caller's reach is the standard refusal", () => {
    async function arrangeWithOffering() {
      const world = await arrangeWithCallers();
      const course = await createCourse(world.alice);
      const offering = await offer(world.alice, { courseId: course.id, termId: world.fall.id });
      return { world, course, offering };
    }

    type Ids = { courseId: string; classOfferingId: string; termId: string };
    const attempts = [
      ["listing Courses", (c: TestClient) => c.get("/courses")],
      ["creating a Course", (c: TestClient) => c.post("/courses", { name: "Biology" })],
      ["creating a Course from a malformed body", (c: TestClient) => c.post("/courses", { name: 5 })],
      ["renaming a Course", (c: TestClient, ids: Ids) => c.patch(`/courses/${ids.courseId}`, { name: "Taken over" })],
      ["deleting a Course", (c: TestClient, ids: Ids) => c.delete(`/courses/${ids.courseId}`)],
      ["listing Class Offerings", (c: TestClient) => c.get("/class-offerings")],
      [
        "offering a Course",
        (c: TestClient, ids: Ids) => c.post("/class-offerings", { courseId: ids.courseId, termId: ids.termId, label: "B" }),
      ],
      ["offering from a malformed body", (c: TestClient) => c.post("/class-offerings", { courseId: 5 })],
      ["reading a Class Offering", (c: TestClient, ids: Ids) => c.get(`/class-offerings/${ids.classOfferingId}`)],
      [
        "relabelling a Class Offering",
        (c: TestClient, ids: Ids) => c.patch(`/class-offerings/${ids.classOfferingId}`, { label: "Mine" }),
      ],
      ["deleting a Class Offering", (c: TestClient, ids: Ids) => c.delete(`/class-offerings/${ids.classOfferingId}`)],
    ] as const;

    const callers = [
      ["a Faculty member", (w: WithCallers) => w.frankie],
      ["a Student", (w: WithCallers) => w.sam],
      ["a Guardian", (w: WithCallers) => w.gina],
      ["another School's Administrator", (w: WithCallers) => w.bob.inSchool(w.northsideId)],
      ["a Platform Administrator", (w: WithCallers) => w.pat],
      ["a caller with no session", (w: WithCallers) => server().client.inSchool(w.northsideId)],
    ] as const;

    // One world, every caller and every action tried within it: each world
    // costs a fresh database and a Person in every role.
    it("refuses every other caller every action exactly as an absent Person is refused, changing nothing", async () => {
      const { world, course, offering } = await arrangeWithOffering();
      const ids = { courseId: course.id, classOfferingId: offering.id, termId: world.fall.id };
      const before = await stored();
      const absent = await world.sam.get(`/persons/${ABSENT_ID}`);
      expect(absent.status).not.toBe(200);

      const answered: string[] = [];
      for (const [caller, as] of callers) {
        for (const [what, attempt] of attempts) {
          const refused = await attempt(as(world), ids);
          if (!isDeepStrictEqual(observable(refused), observable(absent))) {
            answered.push(`${caller}: ${what} answered ${refused.status}`);
          }
        }
      }

      expect(answered).toEqual([]);
      expect(await stored()).toEqual(before);
    });

    it("refuses a Course or Class Offering that does not exist, or is another School's, identically", async () => {
      const { world, course, offering } = await arrangeWithOffering();
      const before = await stored();
      const refusal = await world.sam.get(`/persons/${ABSENT_ID}`);

      const answered: string[] = [];
      for (const [id, path] of [
        [course.id, "/courses/"],
        [offering.id, "/class-offerings/"],
      ] as const) {
        for (const [caller, target] of [
          [world.alice, ABSENT_ID],
          [world.alice, "not-an-identifier"],
          [world.bob, id],
        ] as const) {
          const responses = [
            path === "/class-offerings/" ? await caller.get(`${path}${target}`) : null,
            await caller.patch(`${path}${target}`, path === "/courses/" ? { name: "Renamed" } : { label: "Renamed" }),
            await caller.delete(`${path}${target}`),
          ];
          for (const response of responses) {
            if (response !== null && !isDeepStrictEqual(observable(response), observable(refusal))) {
              answered.push(`${response.status} for ${path}${target}`);
            }
          }
        }
      }

      expect(answered).toEqual([]);
      expect(await stored()).toEqual(before);
    });

    it("records a refused change with its true reason", async () => {
      const { world, course, offering } = await arrangeWithOffering();

      await world.frankie.patch(`/courses/${course.id}`, { name: "Mine now" });
      await world.bob.delete(`/class-offerings/${offering.id}`);

      expect(await trailOf(world.alice, "access.refused")).toEqual([
        expect.objectContaining({ reason: "forbidden", target: { type: "course", id: course.id } }),
      ]);
      expect(await trailOf(world.bob, "access.refused")).toEqual([
        expect.objectContaining({ reason: "outside-school", target: { type: "class_offering", id: offering.id } }),
      ]);
    });
  });
});
