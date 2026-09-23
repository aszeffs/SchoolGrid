import { useEffect, useState } from "react";
import { Account } from "./Account.tsx";
import { api, type ReachedSchool, type Session } from "./api.ts";
import { AuditRecords } from "./AuditRecords.tsx";
import { Enrollments } from "./Enrollments.tsx";
import { GuardianLinks } from "./GuardianLinks.tsx";
import { Invitations } from "./Invitations.tsx";
import { Link } from "./Link.tsx";
import { Memberships } from "./Memberships.tsx";
import { navigate } from "./navigation.ts";
import { NotAvailable } from "./NotAvailable.tsx";
import { ROLE_NAMES } from "./roles.ts";
import { Persons } from "./Persons.tsx";
import { href, landing, sectionOf, sectionsFor, type Route, type SchoolRoute } from "./routes.ts";
import { SchoolSettings } from "./SchoolSettings.tsx";
import { Schools } from "./Schools.tsx";
import { ShellContext, type ShellChrome } from "./ShellContext.ts";
import { Sheet } from "./Sheet.tsx";

type State =
  | { kind: "loading" }
  /** `signOutFailed` when a sign-out did not work, which leaves the session as it was. */
  | { kind: "ready"; session: Session; signOutFailed?: true };

/**
 * Every signed-in page, inside the shell. `route` is null for a path that
 * names nothing.
 *
 * The session is read before anything is shown, so the header and the
 * navigation are right on first paint rather than rearranging after it. It is
 * read again on every move within the app, keeping what is shown meanwhile,
 * so a session that has ended sends the user to sign in at their next step
 * instead of leaving them in a half-working app.
 */
export function SignedIn({ route }: { route: Extract<Route, { name: "schools" }> | SchoolRoute | null }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const location = route === null ? null : href(route);

  useEffect(() => {
    let current = true;
    void api.session().then((session) => {
      if (!current) {
        return;
      }
      // Without a live session, whether it expired, was ended elsewhere or
      // never existed, the way on is to sign in again.
      if (session.ok) {
        setState({ kind: "ready", session: session.body });
      } else {
        navigate({ name: "signIn" }, { replace: true });
      }
    });
    return () => {
      current = false;
    };
  }, [location]);

  const reachesOne = state.kind === "ready" && route?.name === "schools" && state.session.schools.length === 1;
  useEffect(() => {
    if (reachesOne) {
      // Nobody is asked to pick from a list of one.
      const only = state.session.schools[0]!;
      navigate(landing(only.schoolId, only.roles), { replace: true });
    }
  }, [reachesOne, state]);

  const signOut = async () => {
    // A sign-out that did not work leaves the session live, and the sign-in
    // page would send a live session straight back here as if nothing happened.
    if ((await api.signOut()).ok) {
      navigate({ name: "signIn" }, { replace: true });
    } else {
      setState((shown) => (shown.kind === "ready" ? { ...shown, signOutFailed: true } : shown));
    }
  };

  if (state.kind === "loading" || reachesOne) {
    // Named for the page on its way, and nothing more: no School is named
    // until the session says the account reaches it.
    const name = route === null ? "Not available" : route.name === "schools" ? "Schools" : sectionOf(route).label;
    return <Sheet name={name} busy />;
  }

  const { session } = state;
  const who = (name: string) => <span className="sheet__who">Signed in as {name}</span>;
  const signOutButton = (
    <button type="button" className="button-quiet" onClick={signOut}>
      Sign out
    </button>
  );
  const account = (
    <div className="actions">
      {who(session.account.username)}
      {signOutButton}
    </div>
  );

  const notAvailable = (
    <ShellContext.Provider value={{ head: account, account }}>
      <NotAvailable />
    </ShellContext.Provider>
  );
  if (state.signOutFailed) {
    return notAvailable;
  }

  if (route?.name === "schools") {
    return (
      <ShellContext.Provider value={{ head: account, account }}>
        <Schools schools={session.schools} />
      </ShellContext.Provider>
    );
  }

  /*
   * A School the account does not reach and a path that names nothing are the
   * same sheet, shown the same way (ADR-0002): which of the two it was is
   * exactly what the API would not say.
   */
  const school = route === null ? undefined : reached(session, route);
  if (route === null || school === undefined) {
    return notAvailable;
  }

  const chrome: ShellChrome = {
    account,
    head: (
      <div className="shell-head">
        <div className="shell-head__who">
          <p className="shell-head__school">{school.name}</p>
          <div className="shell-head__actor">
            {who(school.displayName)}
            <ul className="held" aria-label={`Your roles in ${school.name}`}>
              {school.roles.map((role) => (
                <li key={role}>{ROLE_NAMES[role]}</li>
              ))}
            </ul>
          </div>
        </div>
        <div className="actions">
          <Switcher current={school} schools={session.schools} />
          {signOutButton}
        </div>
      </div>
    ),
    nav: (
      <nav aria-label={school.name} className="shell-nav">
        <ul>
          {sectionsFor(school.roles).map((section) => (
            <li key={section.name}>
              <Link to={{ name: section.name, schoolId: school.schoolId }} current={section.name === route.name}>
                {section.label}
              </Link>
              {/* The seal on the page being read: one, so a move slides it to the next. */}
              {section.name === route.name && <span className="shell-nav__seal" aria-hidden="true" />}
            </li>
          ))}
        </ul>
      </nav>
    ),
  };

  // Keyed by School, so moving to another School starts every screen afresh:
  // nothing one School's page held is ever shown under another (ADR-0001).
  return (
    <ShellContext.Provider value={chrome} key={school.schoolId}>
      <SchoolScreen route={route} school={school} />
    </ShellContext.Provider>
  );
}

/** The School a route names, if the account reaches it. */
function reached(session: Session, route: SchoolRoute): ReachedSchool | undefined {
  return session.schools.find((school) => school.schoolId === route.schoolId);
}

/**
 * The screen a route within a School names. Every page is shown whatever the
 * actor's roles: the navigation leaves out what they do not reach, but whether
 * a page's records are available is for the server to say when the page asks
 * (ADR-0007).
 */
function SchoolScreen({ route, school }: { route: SchoolRoute; school: ReachedSchool }) {
  switch (route.name) {
    case "account":
      return <Account school={school} />;
    case "persons":
      return <Persons school={school} />;
    case "invitations":
      return <Invitations school={school} />;
    case "memberships":
      return <Memberships school={school} />;
    case "enrollments":
      return <Enrollments school={school} />;
    case "guardianLinks":
      return <GuardianLinks school={school} />;
    case "auditRecords":
      return <AuditRecords school={school} />;
    case "settings":
      return <SchoolSettings school={school} />;
  }
}

/**
 * The account's other Schools, offered only when there are any. A native
 * disclosure, so it opens and closes from the keyboard with no script of its
 * own and no inline style to position it.
 */
function Switcher({ current, schools }: { current: ReachedSchool; schools: ReachedSchool[] }) {
  const others = schools.filter((school) => school.schoolId !== current.schoolId);
  if (others.length === 0) {
    return null;
  }
  return (
    <details className="switcher">
      <summary>Switch School</summary>
      <ul aria-label="Your other Schools">
        {others.map((school) => (
          <li key={school.schoolId}>
            <Link to={landing(school.schoolId, school.roles)}>{school.name}</Link>
          </li>
        ))}
        <li>
          <Link to={{ name: "schools" }}>All your Schools</Link>
        </li>
      </ul>
    </details>
  );
}
