import { participationsIn, type Participation } from "./participation.ts";

/**
 * Roster memberships as stored. Each is one Student's participation in one
 * Class Offering (migrations/0017), stored as every participation is: see
 * ./participation.ts. One that has begun is ended rather than deleted, as the
 * record of who was on its roster and when.
 */
export type RosterMembership = Participation;

export const rosterMemberships = participationsIn({
  kind: "roster_membership",
  personColumn: "student_person_id",
  boundsConflicts: {
    roster_membership_no_overlap: { conflict: "roster_membership_overlap" },
    roster_membership_inside_term: { conflict: "roster_membership_outside_term" },
  },
});

/**
 * Rosters a Person in a Class Offering, or refuses bounds that overlap one of
 * their own memberships of it or fall outside its Term. Whether the Person may
 * be rostered at all is the caller's to have checked.
 */
export const rosterStudent = rosterMemberships.create;
