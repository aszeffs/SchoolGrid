import { participationsIn, type Participation } from "./participation.ts";

/**
 * Teaching assignments as stored. Each is one Faculty member's assignment to
 * one Class Offering (migrations/0016), stored as every participation is: see
 * ./participation.ts. One that has begun is ended rather than deleted, as the
 * record of who taught what and when.
 */
export type TeachingAssignment = Participation;

export const teachingAssignments = participationsIn({
  kind: "teaching_assignment",
  personColumn: "faculty_person_id",
  boundsConflicts: {
    teaching_assignment_no_overlap: { conflict: "teaching_assignment_overlap" },
    teaching_assignment_inside_term: { conflict: "teaching_assignment_outside_term" },
  },
});

/**
 * Assigns a Person to teach a Class Offering, or refuses bounds that overlap
 * one of their own assignments to it or fall outside its Term. Whether the
 * Person may be assigned at all is the caller's to have checked.
 */
export const assignTeaching = teachingAssignments.create;
