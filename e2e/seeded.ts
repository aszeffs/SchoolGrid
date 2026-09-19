/** Where the global setup leaves what it arranged, for the tests to read. */
export const SEEDED = "BROWSER_TEST_SEEDED";

export interface Seeded {
  /** A School Administrator in every School below. */
  schoolAdministrator: { username: string; password: string };
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
