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

/**
 * Every role, in the order a choice of them is offered. Read off the map above,
 * which names each role the API has, rather than imported from the service:
 * the web build is given the service's bounds and nothing else of it.
 */
export const ROLES = Object.keys(ROLE_NAMES) as Role[];
