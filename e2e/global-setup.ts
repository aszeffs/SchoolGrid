import { randomUUID } from "node:crypto";
import { grantMembership, linkGuardian, recordEnrollment } from "../src/access/index.ts";
import { createUserAccount } from "../src/authentication/index.ts";
import { createPool } from "../src/db/pool.ts";
import { createPerson } from "../src/identity/index.ts";
import { provisionSchool } from "../src/platform/index.ts";
import { SEEDED, type Seeded } from "./seeded.ts";

/** The timezone each seeded School keeps, in the order the Schools are named. */
const SCHOOL_TIMEZONES = ["America/New_York", "Europe/London"];

/**
 * Arranges what the browser suite signs in as, directly in the database the
 * server under test uses, as the HTTP suite's harness arranges its fixtures.
 * Accounts are provisioned, never self-registered, so there is no page to do
 * this through.
 *
 * Names carry a random suffix, so the suite can run again against a database
 * it has already run against.
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env["SCHOOLGRID_DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error(
      "SCHOOLGRID_DATABASE_URL must name the database the server under test uses, as the application's login",
    );
  }
  const database = createPool(url);
  try {
    const suffix = randomUUID().slice(0, 8);
    const credentials = { username: `alice-${suffix}`, password: `correct horse battery ${suffix}` };
    const account = await createUserAccount(database, credentials);
    const schools = [`Northside ${suffix}`, `Southside ${suffix}`];
    const schoolIds: string[] = [];
    for (const [index, name] of schools.entries()) {
      const provisioned = await provisionSchool(database, {
        name,
        timezone: SCHOOL_TIMEZONES[index]!,
        schoolAdministrator: { account, displayName: "Alice" },
        platformAdministrator: null,
      });
      if (provisioned === null) {
        throw new Error(`could not provision ${name}`);
      }
      schoolIds.push(provisioned.school.id);
    }

    // Someone whose account reaches the first School alone, with a role that
    // is not a School Administrator's.
    const facultyCredentials = { username: `frankie-${suffix}`, password: `staple battery horse ${suffix}` };
    const facultyAccount = await createUserAccount(database, facultyCredentials);
    const facultyPerson = await createPerson(database, {
      schoolId: schoolIds[0]!,
      displayName: "Frankie",
      userAccountId: facultyAccount.id,
    });
    await grantMembership(database, { person: facultyPerson, role: "faculty" });

    /*
     * A Student and a Guardian of that Student, so the browser suite can sign
     * in as each of the roles that lands on Your account. The Student is
     * enrolled and the link is in force, which is what those pages name.
     */
    const studentCredentials = { username: `sasha-${suffix}`, password: `battery staple horse ${suffix}` };
    const guardianCredentials = { username: `gale-${suffix}`, password: `horse staple correct ${suffix}` };
    const studentAccount = await createUserAccount(database, studentCredentials);
    const guardianAccount = await createUserAccount(database, guardianCredentials);
    const studentPerson = await createPerson(database, {
      schoolId: schoolIds[0]!,
      displayName: "Sasha",
      userAccountId: studentAccount.id,
    });
    const guardianPerson = await createPerson(database, {
      schoolId: schoolIds[0]!,
      displayName: "Gale",
      userAccountId: guardianAccount.id,
    });
    await grantMembership(database, { person: studentPerson, role: "student" });
    await grantMembership(database, { person: guardianPerson, role: "guardian" });
    if ((await recordEnrollment(database, studentPerson)) === null) {
      throw new Error("could not enroll the seeded Student");
    }
    // Someone holding two roles at once, as a teacher whose own child attends
    // the School does, so one page can be asked to show both.
    const severalCredentials = { username: `robin-${suffix}`, password: `staple horse correct ${suffix}` };
    const severalAccount = await createUserAccount(database, severalCredentials);
    const severalPerson = await createPerson(database, {
      schoolId: schoolIds[0]!,
      displayName: "Robin",
      userAccountId: severalAccount.id,
    });
    await grantMembership(database, { person: severalPerson, role: "faculty" });
    await grantMembership(database, { person: severalPerson, role: "guardian" });
    if (
      (await linkGuardian(database, {
        guardian: severalPerson,
        student: studentPerson,
        accessProfile: { attendanceRead: true, resultsRead: true },
      })) === null
    ) {
      throw new Error("could not link the seeded Person holding several roles to the seeded Student");
    }

    const guardianAccessProfile = { attendanceRead: true, resultsRead: false };
    if (
      (await linkGuardian(database, {
        guardian: guardianPerson,
        student: studentPerson,
        accessProfile: guardianAccessProfile,
      })) === null
    ) {
      throw new Error("could not link the seeded Guardian to the seeded Student");
    }

    const seeded: Seeded = {
      schoolAdministrator: { ...credentials, displayName: "Alice" },
      faculty: { ...facultyCredentials, displayName: "Frankie" },
      student: { ...studentCredentials, displayName: "Sasha" },
      guardian: { ...guardianCredentials, displayName: "Gale" },
      severalRoles: { ...severalCredentials, displayName: "Robin" },
      guardianAccessProfile,
      schools,
    };
    // Workers inherit the environment the setup leaves behind.
    process.env[SEEDED] = JSON.stringify(seeded);
  } finally {
    await database.end();
  }
}
