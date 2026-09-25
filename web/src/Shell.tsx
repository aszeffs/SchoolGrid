import { useEffect, useState } from "react";
import { AcademicYears } from "./AcademicYears.tsx";
import { Account } from "./Account.tsx";
import { ClassOffering } from "./ClassOffering.tsx";
import { ClassOfferings } from "./ClassOfferings.tsx";
import { Courses } from "./Courses.tsx";
import { api, type ReachedSchool, type Role, type Session } from "./api.ts";
import { AuditRecords } from "./AuditRecords.tsx";
import { Enrollments } from "./Enrollments.tsx";
import { GuardianLinks } from "./GuardianLinks.tsx";
import { Invitations } from "./Invitations.tsx";
import { Link } from "./Link.tsx";
import { Memberships } from "./Memberships.tsx";
import { navigate } from "./navigation.ts";
import { NotAvailable } from "./NotAvailable.tsx";
import { ROLE_NAMES, ROLES } from "./roles.ts";
import { Persons } from "./Persons.tsx";
import { href, landing, sectionOf, sectionsFor, type Route, type SchoolRoute } from "./routes.ts";
import { SchoolSettings } from "./SchoolSettings.tsx";
import { Schools } from "./Schools.tsx";
import { ShellContext, type ShellChrome } from "./ShellContext.ts";
import { Sheet } from "./Sheet.tsx";
import { StudentClasses } from "./StudentClasses.tsx";
import { rememberTrial, START_FAILED, timeLeft, trialHasEnded, useNow, useStartTrial } from "./trial.ts";
import { YourClasses } from "./YourClasses.tsx";

type State =
  | { kind: "loading" }
  /**
   * `failed` when a sign-out or a change of role did not work, which leaves
   * the session as it was.
   */
  | { kind: "ready"; session: Session; failed?: true };

/**
 * Every signed-in page, inside the shell. `route` is null for a path that
 * names nothing.
 *
 * The session is read before anything is shown, so the header and the
 * navigation are right on first paint rather than rearranging after it. It is
 * read again on every move within the app, keeping what is shown meanwhile,
 * so a session that has ended sends the user to sign in at their next step
 * instead of leaving them in a half-working app.
 *
 * A Trial School's visitor whose trial has expired is sent to the page saying
 * so instead: for them it ended, which signing in again would not undo.
 */
export function SignedIn({ route }: { route: Extract<Route, { name: "schools" }> | SchoolRoute | null }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  // Counted up to read the session again where the path alone would not
  // change: a change of role can land on the page already shown.
  const [reads, setReads] = useState(0);
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
        rememberTrial(session.body.schools.find((school) => school.trialExpiresAt !== undefined)?.trialExpiresAt ?? null);
        setState({ kind: "ready", session: session.body });
      } else {
        navigate({ name: trialHasEnded() ? "trialEnded" : "signIn" }, { replace: true });
      }
    });
    return () => {
      current = false;
    };
  }, [location, reads]);

  /**
   * Moves on once the browser holds another Session, showing nothing of the
   * one it replaced meanwhile: the page on its way is shown only once the
   * session says whom it is for.
   */
  const readAgainAt = (next: Route) => {
    setState({ kind: "loading" });
    setReads((count) => count + 1);
    navigate(next);
  };

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
      rememberTrial(null);
      navigate({ name: "signIn" }, { replace: true });
    } else {
      setState((shown) => (shown.kind === "ready" ? { ...shown, failed: true } : shown));
    }
  };

  const viewAs = async (schoolId: string, role: Role) => {
    if ((await api.switchRole(role)).ok) {
      readAgainAt(landing(schoolId, [role]));
    } else if (trialHasEnded()) {
      navigate({ name: "trialEnded" }, { replace: true });
    } else {
      setState((shown) => (shown.kind === "ready" ? { ...shown, failed: true } : shown));
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
  if (state.failed) {
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
          {school.viewingAs !== undefined && (
            <RoleSwitcher viewingAs={school.viewingAs} onChoose={(role) => void viewAs(school.schoolId, role)} />
          )}
          <Switcher current={school} schools={session.schools} />
          {signOutButton}
        </div>
      </div>
    ),
    ...(school.trialExpiresAt === undefined
      ? {}
      : {
          banner: (
            <TrialBanner
              expiresAt={school.trialExpiresAt}
              onStarted={({ schoolId }) => readAgainAt(landing(schoolId, ["school_administrator"]))}
            />
          ),
        }),
    nav: (
      <nav aria-label={school.name} className="shell-nav">
        <ul>
          {sectionsFor(school.roles).map((section) => (
            <li key={section.name}>
              <Link
                to={{ name: section.name, schoolId: school.schoolId }}
                current={
                  section.name === route.name ? "page" : section.name === sectionOf(route).name ? "section" : undefined
                }
              >
                {section.label}
              </Link>
              {/* The seal on the page being read, or on the list it was opened from: one, so a move slides it to the next. */}
              {section.name === sectionOf(route).name && <span className="shell-nav__seal" aria-hidden="true" />}
            </li>
          ))}
        </ul>
      </nav>
    ),
  };

  // Keyed by the Person acting, so moving to another School, or to another
  // role in a Trial School, starts every screen afresh: nothing one School's
  // page held is ever shown under another (ADR-0001), nor one Person's under
  // another's.
  return (
    <ShellContext.Provider value={chrome} key={school.personId}>
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
    case "classes":
      // The classes a Faculty member teaches, or, for a Student, the ones they are in.
      return school.roles.includes("faculty") ? <YourClasses school={school} /> : <StudentClasses school={school} />;
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
    case "academicYears":
      return <AcademicYears school={school} />;
    case "courses":
      return <Courses school={school} />;
    case "classOfferings":
      return <ClassOfferings school={school} />;
    case "classOffering":
      return <ClassOffering school={school} classOfferingId={route.classOfferingId} />;
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

/**
 * The roles a Trial School's visitor can view it as, beside the one they are
 * viewing it as now. The same native disclosure as the School switcher, but
 * each role is a button: choosing one changes whose Session the browser holds,
 * not only which page it shows.
 */
function RoleSwitcher({ viewingAs, onChoose }: { viewingAs: Role; onChoose: (role: Role) => void }) {
  const [choosing, setChoosing] = useState(false);
  const choose = (role: Role) => {
    setChoosing(true);
    onChoose(role);
  };
  return (
    <details className="switcher switcher--roles">
      <summary>Viewing as {ROLE_NAMES[viewingAs]}</summary>
      <ul aria-label="View this School as">
        {ROLES.filter((role) => role !== viewingAs).map((role) => (
          <li key={role}>
            <button type="button" disabled={choosing} onClick={() => choose(role)}>
              {ROLE_NAMES[role]}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * The slim strip over every sheet in a Trial School, so its visitor is never
 * mistaken about what they are using, or for how much longer. At expiry it
 * moves them to the page saying the trial has ended, on the minute, whether or
 * not they do anything.
 */
function TrialBanner({
  expiresAt,
  onStarted,
}: {
  expiresAt: string;
  onStarted: (trial: { schoolId: string }) => void;
}) {
  const now = useNow();
  const ended = Date.parse(expiresAt) <= now;
  const { start, starting, failure } = useStartTrial(onStarted);

  useEffect(() => {
    if (ended) {
      navigate({ name: "trialEnded" }, { replace: true });
    }
  }, [ended]);

  return (
    <section className="trial-banner" aria-label="Trial School">
      <p>
        <strong>Trial School</strong> · invented data · deleted in{" "}
        <time dateTime={expiresAt}>{timeLeft(expiresAt, now)}</time>
      </p>
      {failure !== null && (
        <p role="alert" className="trial-banner__failure">
          {START_FAILED[failure]}
        </p>
      )}
      <button type="button" className="button-quiet" disabled={starting} onClick={() => void start()}>
        Start over
      </button>
    </section>
  );
}
