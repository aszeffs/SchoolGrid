import type { ConflictDetail, CorrectionRequest, PublishedContent } from "./api.ts";

/** A Term result's parts, in the order a correction lists them, as a reader says each. */
export const RESULT_PARTS = [
  { part: "value", name: "Value" },
  { part: "score", name: "Score" },
  { part: "comment", name: "Comment" },
] as const;

/** One part of a result as a reader reads it: a score or comment it lacks is None. */
export function partText(content: PublishedContent, part: keyof PublishedContent): string {
  const held = content[part];
  return held === null ? "None" : String(held);
}

/** A result's whole content in a phrase: "value B, score 81.5, comment None". */
export function contentText(content: PublishedContent): string {
  return RESULT_PARTS.map(({ part, name }) => `${name.toLowerCase()} ${partText(content, part)}`).join(", ");
}

/** Why raising or deciding a Correction request changed nothing, in the words of the rule. */
export function correctionConflictMessage(conflict: ConflictDetail, kind: CorrectionRequest["kind"] = "attendance"): string {
  const record = kind === "attendance" ? "Attendance" : "result";
  switch (conflict.conflict) {
    case "not_instructional_day":
      return "That date is not an Instructional day in the class’s Term, so it holds no Attendance.";
    case "after_today":
      return "That date has not come yet, so it holds no Attendance.";
    case "not_rostered_on_date":
      return "That Student was not on the class’s roster on that date.";
    case "enrollment_ended":
      return "That Student’s Enrollment had ended by that date.";
    case "unchanged":
      return kind === "attendance"
        ? "The Attendance already holds that status, so there is nothing to correct."
        : "The result already says that, so there is nothing to correct.";
    case "not_published":
      return "That result is not published, so it is changed by saving it, not through a Correction request.";
    case "value_not_in_scale":
      return "That value is not on the School’s current Result value scale, so no result can be given it.";
    case "not_pending":
      return "This request has already been decided or withdrawn.";
    case "own_request":
      return "You raised this request, so another School Administrator decides it.";
    case "target_changed":
      return `The ${record} changed after this request was raised, so approving it would overwrite the newer ${kind === "attendance" ? "mark" : "result"}. Reject it, and raise another if a change is still needed.`;
    default:
      return "That change could not be made.";
  }
}
