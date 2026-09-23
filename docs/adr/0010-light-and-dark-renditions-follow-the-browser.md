# Light and dark renditions follow the browser

SchoolGrid has two renditions, light and dark, and the browser's `prefers-color-scheme` setting picks between them. This supersedes ADR-0009. The ditto-sheet design system that ADR protected is gone: the web app was redesigned as a calm, nearly colourless record with one seal blue for action and state, so its range no longer lives in six coloured stocks that a dark ground could not carry. What the stocks did (saying which page is in front of you) is now done by the School header and the lifted section tab, which read the same in either rendition. Staff use the app across a whole school day, including in dimmed classrooms and in the evening, and they told us the saturated stocks were hard on the eyes. A dark rendition is a comfort that now costs nothing the system means.

## Consequences

- `web/src/styles.css` sets `color-scheme: light dark` and defines every colour as a token on `:root`, redefined once under `@media (prefers-color-scheme: dark)`. A rule that names a raw colour instead of a token breaks one rendition, so none should.
- WCAG 2.2 AA is held twice. `e2e/public-pages.spec.ts` checks that a dark browser gets a different ground and ink, and runs `axe-core` in both renditions.
- There is no manual toggle. The browser's setting is the one control, so there is no preference to store, no flash of the wrong theme on load, and no extra script under the Content Security Policy. A toggle can be added later without revisiting this decision.
