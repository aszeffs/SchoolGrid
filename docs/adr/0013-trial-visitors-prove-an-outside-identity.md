# Trial visitors prove an outside identity

A Trial School used to start with one anonymous click, bounded only by a per-IP limit counted per instance and a global cap. We now require a Trial visitor to sign in with GitHub or Google before starting one. Every trial creates a School's worth of rows, so an outside identity is a far better gate against scripted abuse than an IP address. The same identity lets a visitor who closed the tab return to their live Trial School, and lets us hold them to one live at a time: asking for another while it lives returns them to it, and once it expires a new one starts at once.

A Trial visitor is not a User account and not a Person. We keep only the provider and its subject identifier, never a name or email, and forget the Trial visitor once no Trial School of theirs remains. Inside the trial, access still runs through the Sessions the trial issues for its role User accounts (ADR-0012), so authorization gains no trial special case. We rejected attaching the outside identity to a User account: that would make OAuth a sign-in method for real Schools, pulling the identity model, account linking and Invitations into a change whose only purpose is gating trials.

## Consequences

- The trial's one-click start becomes a provider round trip, which costs a visitor a click and a consent screen. The landing page shows what the trial holds before asking for it.
- The OAuth flow uses state and PKCE; the provider's tokens are used once to read the subject and are not stored.
- Real Schools still sign in with a username and password. Adding OAuth there later is a separate decision.
