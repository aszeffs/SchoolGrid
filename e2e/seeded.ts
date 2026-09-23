/** Where the global setup leaves what it arranged, for the tests to read. */
export const SEEDED = "BROWSER_TEST_SEEDED";

/** A seeded User account, and the display name of the Person it resolves to in each School it reaches. */
export interface Account {
  username: string;
  password: string;
  displayName: string;
}

export interface Seeded {
  /** A School Administrator in every School below. */
  schoolAdministrator: Account;
  /**
   * A Faculty member in the first School below, and in no other, who is also a
   * Guardian of the Student below: one Person holding several roles.
   */
  faculty: Account;
  /** A Student in the first School, enrolled there. */
  student: Account;
  /** A Guardian in the first School, linked to that Student. */
  guardian: Account;
  /** What the Guardian's one link lets them read of the Student's. */
  guardianAccessProfile: { attendanceRead: boolean; resultsRead: boolean };
  /** The names of the Schools that account reaches. */
  schools: string[];
}

export function seeded(): Seeded {
  const value = process.env[SEEDED];
  if (value === undefined) {
    throw new Error("the browser suite's global setup has not run");
  }
  return JSON.parse(value) as Seeded;
}
