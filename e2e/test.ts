import { test as base, expect, type Page } from "@playwright/test";

export { expect };

/**
 * Every test, with every Content Security Policy violation on any page it
 * opens collected, and required to be none.
 *
 * Two sources, because neither sees everything. The page reports what it blocks
 * as a `securitypolicyviolation` event, and Chromium logs what it refuses to
 * the console. The listener is installed by Playwright rather than by the page,
 * so the policy it watches does not stop it running.
 */
export const test = base.extend<{ cspViolations: string[] }>({
  cspViolations: [
    async ({ page }, use) => {
      const violations: string[] = [];
      await watchForViolations(page, violations);
      await use(violations);
      expect(violations, "Content Security Policy violations").toEqual([]);
    },
    { auto: true },
  ],
});

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
