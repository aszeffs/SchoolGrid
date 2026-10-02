import type { ReactNode } from "react";
import { Link } from "./Link.tsx";
import { Key, Sheet } from "./Sheet.tsx";
import { StartTrial } from "./StartTrial.tsx";
import { useTrialProviders } from "./trial.ts";

const REPOSITORY_URL = "https://github.com/aszeffs/SchoolGrid";

/**
 * The public front page, pitched to a School: what SchoolGrid does for one,
 * a tour of it feature by feature as the role that sees each, and how
 * seriously it holds a School's records. Public, like sign-in, and the same
 * for everyone, signed in or not.
 *
 * Its one call to action is a trial, offered only where the deployment offers
 * one, with a provider to sign in with (ADR-0012, ADR-0013). Until the server
 * says so, and if it cannot be asked, there is no button: one that could only
 * fail would be worse than none. Nothing on it is priced or sold.
 *
 * It sells only what is built.
 */
export function Landing() {
  const providers = useTrialProviders();
  const trialsOffered = providers.length > 0;

  const legend = (
    <>
      <h2>Key</h2>
      <p>The words every sheet of SchoolGrid is struck in.</p>
      <dl>
        <Key term="School">
          The boundary every record belongs to. A Person, a Class Offering and every record about them belong to exactly
          one School.
        </Key>
        <Key term="Guardian">
          Someone linked to one Student, with an Access profile saying whether they may read that Student&apos;s
          Attendance, Term results, or both.
        </Key>
        <Key term="Term report">
          One Student&apos;s Term: each Class Offering, its published Term result, and its Attendance totals.
        </Key>
        {trialsOffered && (
          <Key term="Trial School">
            A School of your own, filled with invented data and seen by nobody else. It lives two hours, and is then
            deleted whole.
          </Key>
        )}
      </dl>
    </>
  );

  return (
    <Sheet
      name="Home"
      legend={legend}
      foot={
        <>
          <p>SchoolGrid is a showcase project. It doesn&apos;t host real Schools, and every record in a trial is invented.</p>
          <p className="landing__links">
            <a href={REPOSITORY_URL}>GitHub</a>
            <Link to={{ name: "signIn" }}>Sign in</Link>
          </p>
        </>
      }
    >
      <section className="landing__hero" aria-labelledby="landing-headline">
        <h1 id="landing-headline">A K-12 School&apos;s attendance and results, each seen by the right role</h1>
        <p className="landing__lede">
          Faculty take Attendance in a few clicks and publish Term results only when every one is ready. Each Guardian
          sees what their Access profile grants, and a School Administrator sees every change on the Audit trail.
        </p>
        {trialsOffered && (
          <div className="landing__trial">
            <p>
              Try it in a School of your own, filled with invented Persons, Attendance and Term results. View it as
              each School role, and after two hours it ends and is deleted.
            </p>
            <StartTrial providers={providers} />
            <p className="muted">
              Signing in proves you are a person, not a script. SchoolGrid keeps no name, email or token from it, only
              a keyed hash of your account&apos;s id, and forgets that once your trial is deleted.
            </p>
          </div>
        )}
      </section>

      <Feature id="attendance" heading="Attendance in a few clicks" role="Faculty">
        <p>
          Open today&apos;s Attendance session from the class, mark everyone Present in one action, then change only the
          Students who are late or away. Co-teachers share one session, and a mark someone else changed meanwhile is
          shown, never overwritten. Once the Attendance window closes, a change goes through a Correction request.
        </p>
      </Feature>

      <Feature id="publication" heading="Term results, published safely" role="Faculty">
        <p>
          Term results stay drafts, seen only by the class&apos;s Faculty and School Administrators, until Publication
          releases a whole Class Offering at once. Publication is refused while any Student&apos;s result is missing,
          and a published result changes only through an approved Correction request.
        </p>
      </Feature>

      <Feature id="guardians" heading="Guardians see only what they're granted" role="Guardian">
        <p>
          Each Guardian link carries its own Access profile: Attendance, Term results, or both. The Term report shows a
          Guardian exactly what theirs grants, with nothing marking what is withheld, and the link ends with the
          Student&apos;s Enrollment.
        </p>
      </Feature>

      <Feature id="security" heading="Security and audit" role="School Administrator">
        <dl>
          <Key term="Records isolated per School">
            Every record belongs to exactly one School, and nothing is shared between Schools. A request for a record
            you do not reach is refused the same way as one for a record that does not exist, so a refusal gives
            nothing away.
          </Key>
          <Key term="Audit trail">
            Every sign-in, refusal and sensitive change in a School is written to its Audit trail: who, what and
            when. No one can alter or remove an Audit record; only a whole expired Trial School takes its own with it.
          </Key>
          <Key term="Signed and verified builds">
            The site runs one container image, tested, scanned and signed before it was published.{" "}
            <Link to={{ name: "howThisWasBuilt" }}>How this was built</Link> names that image and gives the command to
            check it yourself.
          </Key>
        </dl>
      </Feature>
    </Sheet>
  );
}

/** One stop on the tour: a feature, the role it is seen as, and what it does. */
function Feature({ id, heading, role, children }: { id: string; heading: string; role: string; children: ReactNode }) {
  const headingId = `tour-${id}`;
  return (
    <section className="landing__feature" aria-labelledby={headingId}>
      <h2 id={headingId}>{heading}</h2>
      <p className="landing__role">Seen as {role}</p>
      {children}
    </section>
  );
}
