// Renders Vitest's coverage-summary.json as a Markdown table for the GitHub
// Actions job summary. Deliberately reports rather than gates: there is no
// threshold, so this never fails the build, not even when the report is
// missing because the test step failed first.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SUMMARY_REPORT_URL = new URL("../coverage/coverage-summary.json", import.meta.url);
const METRICS = ["statements", "branches", "functions", "lines"];

export function formatCoverageSummary(summary) {
  const total = summary?.total;
  if (!total) return "## Coverage\n\nNo coverage report was produced.\n";

  const header = `| ${METRICS.map(titleCase).join(" | ")} |`;
  const rule = `| ${METRICS.map(() => "---:").join(" | ")} |`;
  const row = `| ${METRICS.map((metric) => formatMetric(total[metric])).join(" | ")} |`;

  return `${["## Coverage", "", header, rule, row].join("\n")}\n`;
}

function formatMetric(metric) {
  if (!metric) return "n/a";
  return `${metric.pct}% (${metric.covered}/${metric.total})`;
}

function titleCase(word) {
  return word[0].toUpperCase() + word.slice(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // `.catch` rather than a rejection handler on the same `.then`: a throw from
  // JSON.parse happens inside the fulfilment handler, so a sibling handler
  // never sees it. A test run killed mid-write leaves exactly that truncated
  // report, and this step runs `if: always()`.
  const summary = await readFile(SUMMARY_REPORT_URL, "utf8")
    .then((contents) => JSON.parse(contents))
    .catch(() => null);
  process.stdout.write(formatCoverageSummary(summary));
}
