/**
 * The roles a School membership can grant, as the API names them.
 *
 * Imported by `web/`, so it holds the list and nothing else: no Node built-in,
 * no database, nothing that cannot be bundled into a page. Whether a role may
 * do a given thing is not here; that is the decision in ./index.ts.
 */
export const ROLES = ["school_administrator", "faculty", "student", "guardian"] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return (ROLES as readonly unknown[]).includes(value);
}
