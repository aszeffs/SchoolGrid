import type { Role } from "./api.ts";

/**
 * Each role as CONTEXT.md names it, rather than as the API spells it. One map,
 * so the sign-in page's panel and a signed-in page cannot come to call the
 * same role by two different names.
 */
export const ROLE_NAMES: Record<Role, string> = {
  school_administrator: "School Administrator",
  faculty: "Faculty",
  student: "Student",
  guardian: "Guardian",
};
