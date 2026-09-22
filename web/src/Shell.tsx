import { useEffect, useState } from "react";
import { api, type ReachedSchool, type Session } from "./api.ts";
import { Link } from "./Link.tsx";
import { navigate } from "./navigation.ts";
import { NotAvailable } from "./NotAvailable.tsx";
import { NotBuilt } from "./NotBuilt.tsx";
import { Persons } from "./Persons.tsx";
import { href, landing, sectionsFor, type Route, type SchoolRoute } from "./routes.ts";
import { Schools } from "./Schools.tsx";
import { ShellContext, type ShellChrome } from "./ShellContext.ts";
import { Sheet } from "./Sheet.tsx";

type State =
  | { kind: "loading" }
  | { kind: "ready"; session: Session }
  /** A sign-out that did not work. */
  | { kind: "not-available" };

/**
 * Every signed-in page, inside the shell.
 *
 * The session is read before anything is shown, so the header and the
 * navigation are right on first paint rather than rearranging after it. It is
 * read again on every move within the app, keeping what is shown meanwhile,
 * so a session that has ended sends the user to sign in at their next step
 * instead of leaving them in a half-working app.
 */
export function SignedIn({ route }: { route: Extract<Route, { name: "schools" }> | SchoolRoute }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const location = href(route);

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

  const reachesOne = state.kind === "ready" && route.name === "schools" && state.session.schools.length === 1;
  useEffect(() => {
    if (reachesOne) {
      // Nobody is asked to pick from a list of one.
      navigate(landing(state.session.schools[0]!.schoolId), { replace: true });
    }
  }, [reachesOne, state]);

  const signOut = async () => {
    // A sign-out that did not work leaves the session live, and the sign-in
    // page would send a live session straight back here as if nothing happened.
    if ((await api.signOut()).ok) {
      navigate({ name: "signIn" }, { replace: true });
    } else {
      setState({ kind: "not-available" });
    }
  };

  if (state.kind === "not-available") {
    return <NotAvailable />;
  }
  if (state.kind === "loading" || reachesOne) {
    return <Sheet stock="blue" name="Schools" busy />;
  }

  const { session } = state;
  const signOutButton = (
    <button type="button" className="button-quiet" onClick={signOut}>
      Sign out
    </button>
  );

  if (route.name === "schools") {
    const chrome: ShellChrome = {
      head: (
        <div className="actions">
          <span className="sheet__who">Signed in as {session.account.username}</span>
          {signOutButton}
        </div>
      ),
    };
    return (
      <ShellContext.Provider value={chrome}>
        <Schools schools={session.schools} />
      </ShellContext.Provider>
    );
  }

  /*
   * A School the account does not reach and a page that names nothing are the
   * same sheet, shown the same way (ADR-0002): which of the two it was is
   * exactly what the API would not say. So is a page the actor's roles do not
   * reach, since the navigation never leads there.
   */
  const school = session.schools.find((reached) => reached.schoolId === route.schoolId);
  const sections = school === undefined ? [] : sectionsFor(school.roles);
  if (school === undefined || !sections.some((section) => section.name === route.name)) {
    return <NotAvailable />;
  }

  const chrome: ShellChrome = {
    head: (
      <div className="shell-head">
        <div className="shell-head__who">
          <p className="shell-head__school">{school.name}</p>
          <p className="sheet__who">Signed in as {school.displayName}</p>
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
          {sections.map((section) => (
            <li key={section.name}>
              <Link to={{ name: section.name, schoolId: school.schoolId }} current={section.name === route.name}>
                {section.label}
              </Link>
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

/** The screen a route within a School names. */
function SchoolScreen({ route, school }: { route: SchoolRoute; school: ReachedSchool }) {
  switch (route.name) {
    case "persons":
      return <Persons school={school} />;
    case "invitations":
      return <NotBuilt name="Invitations" note="Pending Invitations are listed on People until then." />;
    case "memberships":
      return <NotBuilt name="Roles" />;
    case "enrollments":
      return <NotBuilt name="Enrollments" />;
    case "guardianLinks":
      return <NotBuilt name="Guardians" />;
    case "auditRecords":
      return <NotBuilt name="Audit" />;
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
            <Link to={landing(school.schoolId)}>{school.name}</Link>
          </li>
        ))}
        <li>
          <Link to={{ name: "schools" }}>All your Schools</Link>
        </li>
      </ul>
    </details>
  );
}
