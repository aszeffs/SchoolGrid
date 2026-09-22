import type { Role } from "../../src/access/roles.ts";

/**
 * Every page the app can show, by name, with the path it is reached at. A
 * `:name` segment is a parameter, and the route's type carries it.
 *
 * The one table both directions read: `parse` turns a location into a route,
 * `href` turns a route back into a location, so a link cannot be written to a
 * path the app would not recognise.
 */
const PATHS = {
  schools: "/",
  signIn: "/sign-in",
  invitation: "/invitation",
  howThisWasBuilt: "/how-this-was-built",
  persons: "/schools/:schoolId/persons",
  invitations: "/schools/:schoolId/invitations",
  memberships: "/schools/:schoolId/memberships",
  enrollments: "/schools/:schoolId/enrollments",
  guardianLinks: "/schools/:schoolId/guardian-links",
  auditRecords: "/schools/:schoolId/audit-records",
} as const;

type Paths = typeof PATHS;
export type RouteName = keyof Paths;

/** The parameters a path names, as `{ schoolId: string }` for `/schools/:schoolId/persons`. */
type Params<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? { [K in Name]: string } & Params<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? { [K in Name]: string }
    : unknown;

type Flatten<T> = { [K in keyof T]: T[K] };

/** One page and its parameters, as `{ name: "persons", schoolId: "…" }`. */
export type Route = { [N in RouteName]: Flatten<{ name: N } & Params<Paths[N]>> }[RouteName];

/** A route that belongs to one School. */
export type SchoolRoute = Extract<Route, { schoolId: string }>;

/** A page within a School, by name. */
export type SchoolRouteName = SchoolRoute["name"];

/** The route a path names, or null when it names none. */
export function parse(path: string): Route | null {
  const segments = path.split("/");
  for (const name of Object.keys(PATHS) as RouteName[]) {
    const pattern = PATHS[name].split("/");
    if (pattern.length !== segments.length) {
      continue;
    }
    const params: Record<string, string> = {};
    const matched = pattern.every((part, index) => {
      const segment = segments[index]!;
      if (!part.startsWith(":")) {
        return part === segment;
      }
      const value = decoded(segment);
      if (value === null || value === "") {
        return false;
      }
      params[part.slice(1)] = value;
      return true;
    });
    if (matched) {
      return { name, ...params } as Route;
    }
  }
  return null;
}

/** Where a route is reached. */
export function href(route: Route): string {
  return PATHS[route.name].replace(/:([A-Za-z]+)/g, (_, param: string) =>
    encodeURIComponent((route as unknown as Record<string, string>)[param]!),
  );
}

/** A path segment as written, decoded; null when it is not validly encoded. */
function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** One entry in a School's navigation: the page, what it is called, and whose roles reach it. */
export interface Section {
  name: SchoolRouteName;
  label: string;
  /** The roles that reach it; null for every role. */
  reachedBy: readonly Role[] | null;
}

/**
 * The pages within a School, in the order the navigation lists them, named
 * after the glossary's terms.
 *
 * `reachedBy` mirrors the server's decisions so the navigation does not lead
 * anyone into a refusal. It is not a permission (ADR-0007): the server decides
 * every request itself, and one it refuses still shows the one "not
 * available" state.
 */
export const SECTIONS: readonly Section[] = [
  { name: "persons", label: "People", reachedBy: null },
  { name: "invitations", label: "Invitations", reachedBy: ["school_administrator"] },
  { name: "memberships", label: "Roles", reachedBy: ["school_administrator"] },
  { name: "enrollments", label: "Enrollments", reachedBy: ["school_administrator"] },
  { name: "guardianLinks", label: "Guardians", reachedBy: ["school_administrator"] },
  { name: "auditRecords", label: "Audit", reachedBy: ["school_administrator"] },
];

/** The sections a Person holding these roles reaches, in navigation order. */
export function sectionsFor(roles: readonly Role[]): Section[] {
  return SECTIONS.filter(
    (section) => section.reachedBy === null || section.reachedBy.some((role) => roles.includes(role)),
  );
}

/** Where a School opens: the first page its navigation lists. */
export function landing(schoolId: string): SchoolRoute {
  return { name: "persons", schoolId };
}
