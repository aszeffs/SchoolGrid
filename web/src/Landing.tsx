import type { ReactNode } from "react";
import { Link } from "./Link.tsx";
import { MiniatureSchool } from "./MiniatureSchool.tsx";
import { Key, Sheet } from "./Sheet.tsx";
import { StartTrial } from "./StartTrial.tsx";
import { useTrialProviders } from "./trial.ts";

const REPOSITORY_URL = "https://github.com/aszeffs/SchoolGrid";

/**
 * The public front page, pitched to a School: what SchoolGrid does for one,
 * beside a School in miniature to try it in before signing in for a trial,
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
          The boundary every record belongs to: each Person, Class Offering and record about them belongs to exactly one
          School.
        </Key>
        <Key term="Guardian">
          Someone linked to one Student, whose Access profile grants that Student&apos;s Attendance, Term results, or
          both.
        </Key>
        <Key term="Term report">
          One Student&apos;s Term: each Class Offering, its published Term result, and its Attendance totals.
        </Key>
        {trialsOffered && (
          <Key term="Trial School">
            A School of your own, with invented data, seen by nobody else. It is deleted whole after two hours.
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
        <div className="landing__pitch">
          <h1 id="landing-headline">A K-12 School&apos;s Attendance and Term results, each seen by the right role</h1>
          <p className="landing__lede">
            Faculty take Attendance in a few clicks and publish Term results when all are ready. Guardians see what
            their Access profile grants, and School Administrators see every change on the Audit trail.
          </p>
          {trialsOffered && (
            <div className="landing__trial">
              <p>Try it in a School of your own, with invented data, as each School role. It is deleted after two hours.</p>
              <StartTrial providers={providers} />
              <p className="muted">
                Signing in only proves you are a person. SchoolGrid keeps no name, email or token, just a keyed hash of
                your account&apos;s id, deleted with your trial.
              </p>
            </div>
          )}
        </div>
        <MiniatureSchool />
      </section>

      <Feature
        id="attendance"
        heading="Attendance in a few clicks"
        role="Faculty"
        screenshot="A Faculty member's Attendance session for Mathematics, with every Student marked Present in one action and one changed to Tardy, ready to save."
      >
        <p>
          Mark everyone Present in one action, then change only the Students who are late or away. Faculty of the same
          Class Offering share one session, and a mark someone else changed is shown, never overwritten. After the
          Attendance window closes, a change needs a Correction request.
        </p>
      </Feature>

      <Feature
        id="publication"
        heading="Term results, published safely"
        role="Faculty"
        screenshot="Publishing three Term results for Mathematics: a confirmation warns that Publication cannot be undone, and that a published result changes only through a Correction request."
      >
        <p>
          Term results stay drafts, seen only by the Class Offering&apos;s Faculty and School Administrators, until
          Publication shows them all at once. It is refused while any result is missing, and a published result changes
          only through an approved Correction request.
        </p>
      </Feature>

      <Feature
        id="guardian"
        heading="Guardians see only what they're granted"
        role="Guardian"
        screenshot="A Guardian's view of their Student's Term report: each Class Offering with its published Term result and Attendance totals."
      >
        <p>
          Each Guardian link has its own Access profile: Attendance, Term results, or both. The Term report shows exactly
          what it grants, with nothing marking what is withheld, and the link ends with the Student&apos;s Enrollment.
        </p>
      </Feature>

      <Feature
        id="security"
        heading="Security and audit"
        role="School Administrator"
        screenshot="The School's Audit trail, newest first: an approved Correction request, the change it made with its reason, and each sign-in, each with who acted and when."
      >
        <dl>
          <Key term="Records isolated per School">
            Every record belongs to exactly one School. A record you cannot reach is refused exactly like one that does
            not exist, so a refusal gives nothing away.
          </Key>
          <Key term="Audit trail">
            Every sign-in, refusal and sensitive change is written to the School&apos;s Audit trail: who, what and when.
            No one can alter or remove an Audit record; only an expired Trial School takes its own with it.
          </Key>
          <Key term="Signed and verified builds">
            The site runs one container image, tested, scanned and signed before publishing.{" "}
            <a href={`${REPOSITORY_URL}#how-this-was-built`}>How this was built</a> traces it from commit to deploy,
            with the command to check it yourself.
          </Key>
        </dl>
      </Feature>
    </Sheet>
  );
}

/** The size every tour screenshot is shot at (playwright.tour.config.ts). */
const SHOT = { width: 1440, height: 900 };

/**
 * One stop on the tour: a feature, the role it is seen as, what it does, and
 * the app showing it. The screenshot is made by `npm run screenshots` in each
 * rendition, and the browser takes the one its own setting asks for
 * (ADR-0010). Each is the size it is shot at, so the page holds its place
 * while it loads.
 */
function Feature({
  id,
  heading,
  role,
  screenshot,
  children,
}: {
  id: string;
  heading: string;
  role: string;
  /** What the screenshot shows, for whoever cannot see it. */
  screenshot: string;
  children: ReactNode;
}) {
  const headingId = `tour-${id}`;
  return (
    <section className="landing__feature" aria-labelledby={headingId}>
      <h2 id={headingId}>{heading}</h2>
      <p className="landing__role">
        Seen as <span>{role}</span>
      </p>
      {children}
      <picture className="landing__screenshot">
        <source srcSet={`/tour/${id}-dark.png`} media="(prefers-color-scheme: dark)" />
        <img src={`/tour/${id}-light.png`} alt={screenshot} width={SHOT.width} height={SHOT.height} loading="lazy" />
      </picture>
    </section>
  );
}
