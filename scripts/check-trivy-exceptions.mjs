// Checks that every Trivy exception carries a justification and an expiry.
//
// Trivy will happily honour `- id: CVE-2025-0001` on its own. That entry is
// indistinguishable from the gate being switched off for one finding, forever,
// by someone who left no record of why. The threshold stays at HIGH and the
// gate stays on; the price of stepping around a finding is saying why, and
// saying when the decision gets revisited.
//
// The parser understands a deliberately narrow subset of Trivy's ignore-file
// format and refuses anything outside it. That is the point rather than a
// limitation: a check that silently skips what it does not recognise reports
// success while an unjustified exception sits underneath it.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const EXCEPTIONS_FILE_NAME = ".trivyignore.yaml";

// Resolved against this module rather than the working directory, so the check
// reads the repository's exception file wherever it is run from. A
// CWD-relative default is right only when invoked from the root, and a check
// that reads the wrong file finds nothing to complain about.
export const EXCEPTIONS_FILE = new URL(`../${EXCEPTIONS_FILE_NAME}`, import.meta.url);

// Long enough that a genuinely unfixable base-image CVE does not need
// re-justifying every sprint, short enough that no exception outlives the
// reasoning behind it.
export const MAX_EXCEPTION_DAYS = 180;

// Enough words to be a reason. "wontfix" and "TODO" are not reasons, and they
// are what gets written when the field is merely mandatory.
const MIN_STATEMENT_LENGTH = 20;

const SECTIONS = ["vulnerabilities", "misconfigurations", "secrets", "licenses"];
const FIELDS = ["id", "statement", "expired_at", "paths"];

const SECTION_LINE = /^([A-Za-z_]+):\s*$/;
const ENTRY_LINE = /^ {2}- ([A-Za-z_]+):(.*)$/;
const FIELD_LINE = /^ {4}([A-Za-z_]+):(.*)$/;
// `>-`, `>`, `|`, `|-` and their indentation-indicator spellings. A
// justification long enough to be one does not fit on a line, so this is the
// shape the file is really written in.
const BLOCK_SCALAR = /^[>|]\d*[-+]?$/;
const FOLDED_LINE = /^ {6,}(\S.*)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MILLISECONDS_PER_DAY = 86_400_000;

export function checkTrivyExceptions(text, { today = new Date() } = {}) {
  const { entries, problems } = parseExceptions(text);

  for (const entry of entries) {
    problems.push(...inspect(entry, today));
  }

  return { ok: problems.length === 0, problems, entries };
}

// Line-oriented rather than a YAML parse, so that every line is either
// understood or reported. A tolerant parse is the failure mode here.
function parseExceptions(text) {
  const entries = [];
  const problems = [];
  let section = null;
  let entry = null;
  // The block scalar currently being collected, if any.
  let folding = null;

  // A folded value ends at the first line indented back out to the entry, so
  // the close happens here rather than where the value started.
  const closeFold = () => {
    if (folding === null) return;
    folding.entry.fields[folding.name] = folding.lines.join(" ");
    folding = null;
  };

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.replace(/\s+$/, "");
    const lineNumber = index + 1;

    // Checked before comments and blank lines, because inside a block scalar
    // both are content rather than layout.
    if (folding !== null) {
      const folded = FOLDED_LINE.exec(line);
      if (folded) {
        folding.lines.push(folded[1]);
        return;
      }
      if (line === "") return;
      closeFold();
    }

    // A full-line comment only. A `#` further along a line is part of a
    // statement, and cutting there would silently truncate a justification.
    if (line === "" || line.trimStart().startsWith("#")) return;

    const sectionMatch = SECTION_LINE.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      entry = null;
      if (!SECTIONS.includes(section)) {
        problems.push(
          `line ${lineNumber}: \`${section}\` is not a section this check ` +
            `understands (expected one of: ${SECTIONS.join(", ")}).`,
        );
      }
      return;
    }

    const entryMatch = ENTRY_LINE.exec(line);
    if (entryMatch) {
      if (section === null) {
        problems.push(`line ${lineNumber}: an exception outside any section.`);
      }
      entry = { section, line: lineNumber, fields: {} };
      entries.push(entry);
      folding = addField(entry, entryMatch[1], entryMatch[2], lineNumber, problems);
      return;
    }

    const fieldMatch = FIELD_LINE.exec(line);
    if (fieldMatch) {
      if (entry === null) {
        problems.push(`line ${lineNumber}: \`${fieldMatch[1]}\` belongs to no exception.`);
        return;
      }
      folding = addField(entry, fieldMatch[1], fieldMatch[2], lineNumber, problems);
      return;
    }

    problems.push(`line ${lineNumber}: cannot read \`${line}\` as part of an exception.`);
  });

  // A block scalar running to the end of the file never meets the dedent that
  // would close it.
  closeFold();

  return { entries, problems };
}

// Returns the block scalar this field opened, for the caller to keep
// collecting, or null for an ordinary single-line value.
function addField(entry, name, rawValue, lineNumber, problems) {
  if (!FIELDS.includes(name)) {
    problems.push(
      `line ${lineNumber}: \`${name}\` is not a field Trivy reads here ` +
        `(expected one of: ${FIELDS.join(", ")}).`,
    );
    return null;
  }

  if (name in entry.fields) {
    problems.push(`line ${lineNumber}: \`${name}\` is given twice for the same exception.`);
    return null;
  }

  const value = rawValue.trim();
  if (BLOCK_SCALAR.test(value)) {
    // Recorded as empty for now. A block that turns out to say nothing then
    // fails the length check as the empty justification it is.
    entry.fields[name] = "";
    return { entry, name, lines: [] };
  }

  entry.fields[name] = unquote(value);
  return null;
}

function unquote(value) {
  const quoted = /^(["|'])(.*)\1$/.exec(value);
  return quoted ? quoted[2] : value;
}

function inspect(entry, today) {
  const problems = [];
  const { id, statement, expired_at: expiresAt } = entry.fields;
  // Every problem names the finding it is about, so a red build points at a
  // line rather than at the file.
  const subject = id ? `\`${id}\`` : `the exception on line ${entry.line}`;

  if (!id) {
    problems.push(`line ${entry.line}: this exception has no \`id\`, so it names no finding.`);
  }

  if (!statement || statement.trim().length < MIN_STATEMENT_LENGTH) {
    problems.push(
      `${subject}: needs a \`statement\` of at least ${MIN_STATEMENT_LENGTH} ` +
        "characters saying why the finding cannot be fixed.",
    );
  }

  if (!expiresAt) {
    problems.push(
      `${subject}: needs an \`expired_at\` date, so the decision is ` +
        "revisited rather than inherited.",
    );
    return problems;
  }

  const expiry = parseDate(expiresAt);
  if (expiry === null) {
    problems.push(`${subject}: \`expired_at: ${expiresAt}\` is not a YYYY-MM-DD date.`);
    return problems;
  }

  const days = Math.round((expiry - startOfDay(today)) / MILLISECONDS_PER_DAY);
  if (days < 0) {
    problems.push(
      `${subject}: the exception expired on ${expiresAt}. Remove it if the ` +
        "finding is gone, or renew it with a fresh justification.",
    );
  } else if (days > MAX_EXCEPTION_DAYS) {
    problems.push(
      `${subject}: \`expired_at: ${expiresAt}\` is ${days} days out; no ` +
        `exception may run longer than ${MAX_EXCEPTION_DAYS} days without review.`,
    );
  }

  return problems;
}

// `Date.parse` accepts 2026-13-40 by rolling it over into the following year,
// which would let a typo through as a date far in the future. Round-tripping
// the parse back to a string is what catches that.
function parseDate(value) {
  if (!ISO_DATE.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === value ? parsed : null;
}

function startOfDay(date) {
  return new Date(`${date.toISOString().slice(0, 10)}T00:00:00Z`);
}

export function formatTrivyExceptionReport(file, { ok, problems, entries }) {
  const lines = ["## Trivy exceptions", "", `File: \`${file}\``, ""];

  if (ok) {
    const count = entries?.length ?? 0;
    lines.push(
      count === 0
        ? "No exceptions are recorded. Every finding is going through the gate. Ok."
        : `${count} exception(s) recorded, each with a justification and an ` +
          `expiry inside ${MAX_EXCEPTION_DAYS} days. Ok.`,
    );
  } else {
    lines.push("Every exception must name a finding, say why it cannot be fixed, and expire.", "");
    lines.push(...problems.map((problem) => `- ${problem}`));
    lines.push("", "See `docs/trivy-exceptions.md`.");
  }

  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A path argument is for the tests and for trying a candidate file by hand;
  // with none, the repository's own file is what gets checked.
  const given = process.argv[2];
  const file = given ?? EXCEPTIONS_FILE;

  // A missing file means no exceptions, which is the healthy state rather than
  // an error. Anything else about reading it is an error.
  const text = await readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });

  const result = checkTrivyExceptions(text);
  const report = formatTrivyExceptionReport(given ?? EXCEPTIONS_FILE_NAME, result);
  process.stdout.write(report);

  // This one gates, unlike the other two report-only scripts here. An
  // unjustified or immortal exception is the gate being quietly switched off,
  // which is worse than the finding it steps around.
  process.exit(result.ok ? 0 : 1);
}
