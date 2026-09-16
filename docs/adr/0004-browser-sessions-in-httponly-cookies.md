# Browser sessions in httpOnly cookies

A browser holds its session in a `Secure`, `httpOnly`, `SameSite=Strict` cookie set by sign-in on SchoolGrid's own origin, and page script never sees the session token. Bearer tokens stay for clients that are not browsers. We rejected giving the SPA a Bearer token. In `localStorage`, any XSS can steal the session and use it from anywhere, long after the page closes. Held in memory, XSS can still use it while the page is open, and every refresh signs the user out. For records about children, a session that script cannot read is worth taking on CSRF, which same-origin serving lets us close cheaply.

## Consequences

- A cookie is ambient, so every request that changes something and is authenticated by the cookie must carry an `Origin` matching SchoolGrid's own. `SameSite=Strict` is the first defence and the Origin check is the second. Neither is dropped because the other exists.
- The SPA and the API must stay on one origin (the web bundle ships in the same image and the API lives under `/api`). Splitting them across origins would mean revisiting this decision, not loosening the cookie.
- A browser sign-in never returns the token in the response body. A client that wants a Bearer token asks for one explicitly.
- A refused request is refused identically however its session was presented (ADR-0002): a missing cookie, a stale cookie, a failed Origin check and a bad Bearer token all get the one refusal.
- Two ways to present a session means two paths to test. Both stay covered, and a request presenting both is refused rather than choosing between them.
