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
 * axe-core. Every page still open in the test's context is audited as it
 * stands when the test ends, and a test that passes through a state worth
 * holding to the bar — a dialog open, a record at 360px, a page in a context
 * of its own — audits it there and then. Between them the suite covers every
 * sheet the app has: Sign in, Schools, Your account, Persons, Invitations,
 * School memberships, Enrollments, Guardian links, Academic Years, Audit,
 * School settings, Redeem Invitation, How this was built and Not available.
 *
 * And every test requires that nothing it sent was throttled. The whole suite
 * reaches the server from one client address, and the rate limit is per
 * address and per instance, so the suite spends one client's allowance.
 * scripts/smoke-test.sh widens it for exactly that reason (RATE_LIMIT_MAX).
 * A throttled request would otherwise surface as a screen that never finished
 * loading, blamed on whatever the test was waiting for; this names the cause.
 */
export const test = base.extend<{ cspViolations: string[]; audit: Audit; throttled: string[] }>({
  throttled: [
    async ({ context }, use) => {
      const throttled: string[] = [];
      context.on("response", (response) => {
        if (response.status() === 429) {
          throttled.push(`${response.request().method()} ${new URL(response.url()).pathname}`);
        }
      });
      await use(throttled);
      expect(throttled, "requests throttled by the rate limit; raise RATE_LIMIT_MAX in scripts/smoke-test.sh").toEqual(
        [],
      );
    },
    { auto: true },
  ],
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
    async ({ context, baseURL }, use) => {
      await use(auditFor);
      // What a test leaves on the screen is a page a user can be left on too,
      // for every page it opened, not only the one it was given. A test that
      // opens a browser context of its own — an invitee's, a stale link's —
      // audits that page itself, since the context is gone by the time this
      // runs.
      for (const opened of context.pages()) {
        if (!opened.isClosed() && isAppPage(opened, baseURL)) {
          await auditFor(opened);
        }
      }
    },
    { auto: true },
  ],
});

/** Holds a page to WCAG 2.2 AA as it stands, and fails the test on a violation. */
export type Audit = (page: Page) => Promise<void>;

/**
 * That the sheet is read down rather than scrolled across, at whatever width
 * the test has set. A record that will not hold its viewport says so here
 * rather than in a screenshot nobody looks at.
 */
export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const width = page.viewportSize()?.width;
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
    `the sheet scrolls sideways at ${width ?? "this width"}px`,
  ).toBe(false);
}

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
  // A control fading between states, such as a button coming back from
  // disabled once a change lands, is measured as it will stand rather than
  // midway: a colour halfway through a transition is neither one the sheet
  // shows at rest. A looping animation never finishes, so it is not awaited.
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((animation) => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity),
  );
  const results = await page.evaluate(
    (options: RunOptions) =>
      (window as unknown as { axe: { run(options: RunOptions): Promise<AxeResults> } }).axe.run(options),
    WCAG_22_AA,
  );

  expect(results.violations.map(violationLine), `axe-core violations on ${new URL(page.url()).pathname}`).toEqual(
    [],
  );
}

/** A violation as a line a reader can act on, rather than as a wall of JSON. */
function violationLine(violation: AxeResults["violations"][number]): string {
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
