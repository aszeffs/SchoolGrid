# No component library under the Content Security Policy

The web app is styled with Tailwind CSS and hand-built primitives, and adopts no component library. The Content Security Policy sets `style-src 'self'` with no exception for inline styles, and `web/vite.config.ts` fails the build on any `style=` attribute, so a kit that positions overlays with inline styles cannot run here. Radix does exactly that, which rules out shadcn/ui and every library built on it; MUI and its emotion runtime need an inline `<style>` at runtime for the same reason. Tailwind compiles to one stylesheet served from our own origin and adds nothing to the runtime, so it fits the policy without loosening it. Overlays use the native `<dialog>` element, which brings focus trapping and Escape handling with no inline styles at all.

## Consequences

- Every interactive primitive — dialog, menu, disclosure, tooltip — is ours to build and ours to make accessible. WCAG 2.2 AA is a stated bar rather than something inherited from a library, and `axe-core` runs against every screen the browser suite opens.
- Anything positioned relative to a trigger must be positioned without inline styles. Native `<dialog>` and CSS anchor positioning are the tools; a popover library that writes `style="transform: ..."` is not, however well it is otherwise regarded.
- The build-time inline-code check is the enforcement, not the review. A dependency that only violates the policy in the browser would be found late; failing the build finds it the first time it is used.
- Typography stays on the `system-ui` stack. The policy declares no `font-src`, so `default-src 'self'` applies and a hosted webfont is blocked outright. Self-hosting one is possible and was rejected for image weight, not policy.
- A future contributor will suggest shadcn/ui, because Tailwind is here and the two usually arrive together. The answer is this ADR, not a CSP exception. Loosening `style-src` to admit a component kit would weaken the policy that ADR-0004's cookie decision leans on.
