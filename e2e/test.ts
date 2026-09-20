import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test as base, expect, type Page } from "@playwright/test";
import type { AxeResults, RunOptions } from "axe-core";

export { expect };

/**
 * Every test, with every Content Security Policy violation on any page it
 * opens collected, and required to be none.
 *
 * Two sources, because neither sees everything. The page reports what it blocks
 * as a `securitypolicyviolation` event, and Chromium logs what it refuses to
 * the console. The listener is installed by Playwright rather than by the page,
 * so the policy it watches does not stop it running.
 *
 * Every test also carries `audit`, which holds a page to WCAG 2.2 AA with
 * axe-core. The page the test is given is audited as it stands when the test
 * ends, whatever it opened along the way; a test that passes through a state
 * worth holding to the bar — a dialog open, a record listed, a refusal shown —
 * audits it there and then.
 */
export const test = base.extend<{ cspViolations: string[]; audit: Audit }>({
  cspViolations: [
    async ({ page }, use) => {
      const violations: string[] = [];
      await watchForViolations(page, violations);
      await use(violations);
      expect(violations, "Content Security Policy violations").toEqual([]);
    },
    { auto: true },
  ],
  audit: [
    async ({ page, baseURL }, use) => {
      await use(auditFor);
      // What the test leaves on the screen is a page a user can be left on too.
      if (!page.isClosed() && isAppPage(page, baseURL)) {
        await auditFor(page);
      }
    },
    { auto: true },
  ],
});

/** Holds a page to WCAG 2.2 AA as it stands, and fails the test on a violation. */
export type Audit = (page: Page) => Promise<void>;

/**
 * Whether what the page is showing is one of the app's own pages, and so
 * something the bar applies to.
 *
 * Two things a test can be left on are not. Another site's page — a test that
 * ends on one is testing what SchoolGrid refuses it, and that markup is not
 * ours. And a response under `/api`, which a browser left on a refusal will
 * render as a bare document with neither a title nor a language: it is an
 * answer to a program, and no one navigates to it.
 */
function isAppPage(page: Page, baseURL: string | undefined): boolean {
  if (baseURL === undefined) {
    return false;
  }
  const url = new URL(page.url());
  return url.origin === new URL(baseURL).origin && !url.pathname.startsWith("/api/");
}

/**
 * axe-core, as the browser will run it. It is passed to `page.evaluate`, which
 * the Content Security Policy does not govern, rather than added to the page
 * as a `<script>`, which `script-src 'self'` would rightly block.
 */
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

/** The bar the app states it meets, and nothing beyond it. */
const WCAG_22_AA: RunOptions = {
  runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
  resultTypes: ["violations"],
};

async function auditFor(page: Page): Promise<void> {
  const loaded = await page.evaluate(() => "axe" in window);
  if (!loaded) {
    // Evaluated through the debugger rather than added as a `<script>`, which
    // `script-src 'self'` would block, and which would make the audit itself
    // the violation it is looking for.
    await page.evaluate(AXE);
  }
  const results = await page.evaluate(
    (options: RunOptions) =>
      (window as unknown as { axe: { run(options: RunOptions): Promise<AxeResults> } }).axe.run(options),
    WCAG_22_AA,
  );

  expect(results.violations.map(describe), `axe-core violations on ${new URL(page.url()).pathname}`).toEqual(
    [],
  );
}

/** A violation as a line a reader can act on, rather than as a wall of JSON. */
function describe(violation: AxeResults["violations"][number]): string {
  const where = violation.nodes.map((node) => node.target.join(" ")).join(", ");
  return `${violation.id} (${violation.impact ?? "unknown"}): ${violation.help} — ${where}`;
}

async function watchForViolations(page: Page, violations: string[]): Promise<void> {
  await page.exposeFunction("reportCspViolation", (violation: string) => {
    violations.push(violation);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const report = (window as unknown as { reportCspViolation(violation: string): void })
        .reportCspViolation;
      report(`${event.violatedDirective} blocked ${event.blockedURI || "inline"} on ${location.pathname}`);
    });
  });
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) {
      violations.push(message.text());
    }
  });
}
