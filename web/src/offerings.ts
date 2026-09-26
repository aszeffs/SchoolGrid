import type { ClassOffering, ConflictDetail, Course } from "./api.ts";

/** A Course as a reader picks it out: by name, with its code when it has one. */
export function courseTitle(course: Course): string {
  return course.code === null ? course.name : `${course.name} (${course.code})`;
}

/** The six Course colours, each a token in both renditions. */
const HUES = ["indigo", "rose", "teal", "amber", "violet", "sky"] as const;

export type Hue = (typeof HUES)[number];

/**
 * The colour a Course owns, the same on every page and for every role. It is
 * worked out from the Course's id alone, since no page but a School
 * Administrator's reads the School's whole list of Courses; two Courses can
 * therefore share one, and are still told apart by name and code.
 */
export function courseHue(course: { id: string }): Hue {
  let hash = 0;
  for (const character of course.id) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return HUES[hash % HUES.length]!;
}

/** A Class Offering by its Course, and its label when it has one. */
export function offeringName(offering: ClassOffering): string {
  return offering.label === null ? offering.course.name : `${offering.course.name}, ${offering.label}`;
}

/** The last day a Roster membership runs to: its own, or its Term's while it is open. */
export function runsTo(membership: { lastDate: string | null }, term: { lastDate: string }): string {
  return membership.lastDate ?? term.lastDate;
}

/** Why an offering was not made or relabelled, in the words of the rule it would have broken. */
export function labelConflictMessage(conflict: ConflictDetail, course: string, term: string): string {
  return conflict.conflict === "class_offering_label_taken"
    ? `${course} is already offered in ${term} with that label, or without one. Give this offering a label that tells the two apart.`
    : "That change could not be made.";
}
