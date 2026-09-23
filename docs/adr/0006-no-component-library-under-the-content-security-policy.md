# No component library under the Content Security Policy

The web app is styled by one stylesheet of its own, `web/src/styles.css`, with hand-built primitives, and adopts no component library. The Content Security Policy sets `style-src 'self'` with no exception for inline styles, and `web/vite.config.ts` fails the build on any `style=` attribute, so a kit that positions overlays with inline styles cannot run here. Radix does exactly that, which rules out shadcn/ui and every library built on it; MUI and its emotion runtime need an inline `<style>` at runtime for the same reason. Overlays use the native `<dialog>` element, which brings the inert page, the focus trap and the Escape handling with no inline styles at all, and `preventDefault()` on its `cancel` event withholds that last one where a dialog must not be dismissed by accident.

## Consequences

- Every interactive primitive — dialog, menu, disclosure, tooltip — is ours to build and ours to make accessible. WCAG 2.2 AA is a stated bar rather than something inherited from a library, and `axe-core` runs against every screen the browser suite opens.
- Anything positioned relative to a trigger must be positioned without inline styles. Native `<dialog>` and CSS anchor positioning are the tools; a popover library that writes `style="transform: ..."` is not, however well it is otherwise regarded.
- The build-time inline-code check is the enforcement, not the review. A dependency that only violates the policy in the browser would be found late; failing the build finds it the first time it is used.
- Typography is self-hosted and served from our own origin. The policy declares no `font-src`, so `default-src 'self'` applies and a hosted webfont is blocked outright; the faces the design system names ship as files in the image.
- New controls are written in `web/src/` and `web/src/styles.css`, following `web/DESIGN.md`. Reaching for a dependency to avoid writing one is not the cheaper path here: it does not ship.
- A third-party library is admissible only if it emits no inline style and no inline script at runtime. That has to be checked against what it does, not against what its README claims, and the build check and the browser suite are where it is proved.
- A future contributor will suggest shadcn/ui, because it is what the ecosystem reaches for. The answer is this ADR, not a CSP exception — not `'unsafe-inline'`, not a nonce, not a hash. Loosening `style-src` to admit a component kit would weaken the policy that ADR-0004's cookie decision leans on.
