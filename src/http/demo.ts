import type { FastifyInstance } from "fastify";
import type { Role } from "../access/memberships.ts";

/** A sign-in the public demo publishes, for a visitor to try a role with. */
export interface DemoAccount {
  role: Role;
  username: string;
  password: string;
}

/**
 * The public demo's sign-ins, one for each School role, in the order the
 * sign-in page offers them. demo/seed.sql creates their accounts, holding a
 * hash of each password here: the two must be changed together.
 *
 * The passwords are public, and .gitleaks.toml allows them by name. They reach
 * only the invented demo School. No Platform Administrator's is published.
 */
export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  { role: "school_administrator", username: "demo.administrator", password: "try-schoolgrid-administrator" },
  { role: "faculty", username: "demo.faculty", password: "try-schoolgrid-faculty" },
  { role: "student", username: "demo.student", password: "try-schoolgrid-student" },
  { role: "guardian", username: "demo.guardian", password: "try-schoolgrid-guardian" },
];

/**
 * Serves the demo's sign-ins, for the sign-in page's "Try a role" panel.
 *
 * Registered whatever the mode, so every server has the same routes. Off, as
 * everywhere but the public demo, it publishes none: those accounts exist only
 * in the demo database, and a page offering them anywhere else would offer
 * sign-ins that cannot work, or that work on accounts someone forgot to remove.
 */
export function registerDemoRoute(api: FastifyInstance, demoMode: boolean): void {
  const body = { accounts: demoMode ? DEMO_ACCOUNTS : [] };
  api.get("/demo", async (_request, reply) => reply.status(200).send(body));
}
