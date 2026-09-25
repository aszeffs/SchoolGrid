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
  trialEnded: "/trial-ended",
  account: "/schools/:schoolId/account",
  classes: "/schools/:schoolId/classes",
  persons: "/schools/:schoolId/persons",
  invitations: "/schools/:schoolId/invitations",
  memberships: "/schools/:schoolId/memberships",
  enrollments: "/schools/:schoolId/enrollments",
  guardianLinks: "/schools/:schoolId/guardian-links",
  auditRecords: "/schools/:schoolId/audit-records",
  academicYears: "/schools/:schoolId/academic-years",
  courses: "/schools/:schoolId/courses",
  classOfferings: "/schools/:schoolId/class-offerings",
  classOffering: "/schools/:schoolId/class-offerings/:classOfferingId",
  settings: "/schools/:schoolId/settings",
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
type SchoolRouteName = SchoolRoute["name"];

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

/**
 * The pages within a School that are not sections of their own, each with the
 * section it is reached from: one record, opened from its list.
 */
const WITHIN = {
  classOffering: "classOfferings",
} as const satisfies Partial<Record<SchoolRouteName, SchoolRouteName>>;

/** A page within a School that is a section of its own, reached from the navigation with the School alone. */
type SectionName = Exclude<SchoolRouteName, keyof typeof WITHIN>;

/** One entry in a School's navigation: the page, what it is called, and whose roles reach it. */
export interface Section {
  name: SectionName;
  label: string;
  /** The roles that reach it; null for every role. */
  reachedBy: readonly Role[] | null;
}

/**
 * The pages within a School, in the order the navigation lists them, named
 * after the glossary's terms. Two are listed by a plainer word than the sheet
 * they open: People opens Persons, and Roles opens School memberships.
 *
 * `reachedBy` mirrors the server's decisions so the navigation does not lead
 * anyone into a refusal. It is not a permission (ADR-0007): the server decides
 * every request itself, and one it refuses still shows the one "not
 * available" state.
 */
export const SECTIONS: readonly Section[] = [
  { name: "account", label: "Your account", reachedBy: null },
  { name: "classes", label: "Your classes", reachedBy: ["faculty", "student"] },
  { name: "persons", label: "People", reachedBy: null },
  { name: "invitations", label: "Invitations", reachedBy: ["school_administrator"] },
  { name: "memberships", label: "Roles", reachedBy: ["school_administrator"] },
  { name: "enrollments", label: "Enrollments", reachedBy: ["school_administrator"] },
  { name: "guardianLinks", label: "Guardians", reachedBy: ["school_administrator"] },
  { name: "academicYears", label: "Academic Years", reachedBy: ["school_administrator"] },
  { name: "courses", label: "Courses", reachedBy: ["school_administrator"] },
  { name: "classOfferings", label: "Class Offerings", reachedBy: ["school_administrator"] },
  { name: "auditRecords", label: "Audit", reachedBy: ["school_administrator"] },
  { name: "settings", label: "Settings", reachedBy: ["school_administrator"] },
];

/** The sections a Person holding these roles reaches, in navigation order. */
export function sectionsFor(roles: readonly Role[]): Section[] {
  return SECTIONS.filter(
    (section) => section.reachedBy === null || section.reachedBy.some((role) => roles.includes(role)),
  );
}

/** The navigation's entry for a page within a School, or for the list a record's own page is opened from. */
export function sectionOf(route: SchoolRoute): Section {
  const name = route.name in WITHIN ? WITHIN[route.name as keyof typeof WITHIN] : route.name;
  return SECTIONS.find((section) => section.name === name)!;
}

/**
 * Where a School opens for a Person holding these roles.
 *
 * A School Administrator opens on the School itself, which is what they are
 * there to run. Everyone else opens on their own account: a Faculty member, a
 * Student and a Guardian are each there for what they hold, not for a list of
 * other Persons.
 */
export function landing(schoolId: string, roles: readonly Role[]): SchoolRoute {
  return roles.includes("school_administrator") ? { name: "persons", schoolId } : { name: "account", schoolId };
}
