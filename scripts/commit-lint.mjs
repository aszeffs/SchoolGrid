// Checks a pull request title against Conventional Commits and renders the
// verdict for the GitHub Actions job summary. Merges are squash-only, so the
// pull request title becomes the commit subject on the trunk; linting the
// branch's own commits would police messages that squashing discards.
//
// Deliberately reports rather than gates. This is the one check in the
// pipeline guarding a convention rather than a property of the software, and a
// naming quibble should never stand between a security fix and `main`.
import { pathToFileURL } from "node:url";

export const ALLOWED_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "chore",
  "ci",
];

const EXAMPLE = "feat(audit): record refused sign-ins";

// Type, an optional scope, an optional `!` for a breaking change, then `: ` and
// a subject. Lowercase only: a case-insensitive match would let `Feat` and
// `feat` both through and the convention would drift.
const TITLE_PATTERN = new RegExp(String.raw`^(${ALLOWED_TYPES.join("|")})(\([^()]+\))?!?: \S`);

export function lintPullRequestTitle(title) {
  if (typeof title !== "string" || title.trim() === "") {
    return { valid: false, reason: "The pull request title is empty." };
  }

  if (TITLE_PATTERN.test(title)) return { valid: true, reason: "" };

  // Naming the offending type is more useful than repeating the grammar, and
  // it is the mistake that actually happens: a real subject under a type the
  // convention does not carry.
  const written = title.match(/^([A-Za-z]+)(\([^()]+\))?!?:/);
  if (written && !ALLOWED_TYPES.includes(written[1])) {
    return {
      valid: false,
      reason: `\`${written[1]}\` is not an allowed type. Use one of: ${ALLOWED_TYPES.join(", ")}.`,
    };
  }

  return {
    valid: false,
    reason: `The title must read \`type(optional scope): subject\`, for example \`${EXAMPLE}\`.`,
  };
}

export function formatCommitLintSummary(title) {
  const { valid, reason } = lintPullRequestTitle(title);
  const shown = typeof title === "string" && title.trim() !== "" ? title : "(empty)";
  const lines = ["## Commit lint", "", `Title: \`${shown}\``, ""];

  if (valid) {
    lines.push("This title follows Conventional Commits.");
  } else {
    lines.push(
      reason,
      "",
      `Example of a title that passes: \`${EXAMPLE}\``,
      "",
      "This check is advisory and does not block the merge.",
    );
  }

  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Exit 0 whatever the verdict. The report is the point; failing here would
  // turn an advisory check into a gate.
  process.stdout.write(formatCommitLintSummary(process.env.PR_TITLE));
}
