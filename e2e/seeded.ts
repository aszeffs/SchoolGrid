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
  /** A Faculty member in the first School below, and in no other. */
  faculty: Account;
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
