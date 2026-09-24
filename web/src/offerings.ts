import type { ClassOffering, ConflictDetail, Course } from "./api.ts";

/** A Course as a reader picks it out: by name, with its code when it has one. */
export function courseTitle(course: Course): string {
  return course.code === null ? course.name : `${course.name} (${course.code})`;
}

/** A Class Offering by its Course, and its label when it has one. */
export function offeringName(offering: ClassOffering): string {
  return offering.label === null ? offering.course.name : `${offering.course.name}, ${offering.label}`;
}

/** Why an offering was not made or relabelled, in the words of the rule it would have broken. */
export function labelConflictMessage(conflict: ConflictDetail, course: string, term: string): string {
  return conflict.conflict === "class_offering_label_taken"
    ? `${course} is already offered in ${term} with that label, or without one. Give this offering a label that tells the two apart.`
    : "That change could not be made.";
}
