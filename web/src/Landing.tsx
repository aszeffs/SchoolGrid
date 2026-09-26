import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { Link } from "./Link.tsx";
import { Key, Sheet } from "./Sheet.tsx";
import { StartTrial } from "./StartTrial.tsx";

const REPOSITORY_URL = "https://github.com/aszeffs/SchoolGrid";

/**
 * The public front page: what SchoolGrid is and whom it is for, a trial of
 * it, and how seriously it holds a School's records. Public, like sign-in,
 * and the same for everyone, signed in or not.
 *
 * The trial is offered only where the deployment offers one (ADR-0012).
 * Until the server says so, and if it cannot be asked, there is no button:
 * one that could only fail would be worse than none.
 *
 * It sells only what is built. What is not yet, such as Attendance and Term
 * results, it does not name.
 */
export function Landing() {
  const [trialsOffered, setTrialsOffered] = useState(false);

  useEffect(() => {
    let current = true;
    void api.trials().then((trials) => {
      if (current && trials.ok) {
        setTrialsOffered(trials.body.enabled);
      }
    });
    return () => {
      current = false;
    };
  }, []);

  const legend = (
    <>
      <h2>Key</h2>
      <p>The words every sheet of SchoolGrid is struck in.</p>
      <dl>
        <Key term="School">
          The boundary every record belongs to. A Person, a Class Offering and every record about them belong to exactly
          one School.
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
      <h1>Academic records for K-12 Schools</h1>
      <p>
        SchoolGrid keeps a School&apos;s Persons, Enrollments, Guardian links, Academic Years, Courses and Class
        Offerings. A School Administrator runs the School, and every Faculty member, Student and Guardian sees what
        their own role in it reaches, and nothing more.
      </p>
      {trialsOffered && (
        <div className="landing__trial">
          <p>
            Try it in a School of your own, filled with invented Persons and Class Offerings. View it as each School role,
            and after two hours it ends and is deleted.
          </p>
          <StartTrial label="Start a trial" />
        </div>
      )}

      <section className="landing__trust" aria-labelledby="trust">
        <h2 id="trust">Trust &amp; security</h2>
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
      </section>
    </Sheet>
  );
}
