import { useEffect, useState, type FormEvent } from "react";
import { api, type DemoAccount } from "./api.ts";
import { Link } from "./Link.tsx";
import { navigate } from "./navigation.ts";
import { ROLE_NAMES } from "./roles.ts";
import { Key, Sheet } from "./Sheet.tsx";

/**
 * What each role reaches once it is signed in, so a visitor picks a
 * perspective rather than a button. One line each, read out with the button it
 * describes.
 *
 * What these promise is what `SECTIONS` in routes.ts actually lists for those
 * roles, and no more: the School Administrator runs the School, and every
 * other role lands on their own account. A line that sold the academic screens
 * would mis-sell three roles of the four, so each says plainly where its own
 * screens stop.
 */
const ROLE_SEES: Record<DemoAccount["role"], string> = {
  school_administrator:
    "Every Person in the School, with their Invitations, School memberships, Enrollments, Guardian links and Audit records, and the School's settings.",
  faculty: "Their own account and the School's People. The Class Offerings they teach are not built yet.",
  student:
    "Their own account: the School memberships they hold, and their Enrollment. Their published academic records are not built yet.",
  guardian:
    "Their own account: each Student they are linked to, and what that link lets them read. Those records are not built yet.",
};

/** The id of the line describing a role, named once so button and line cannot drift apart. */
const seesId = (role: DemoAccount["role"]) => `sees-${role}`;

export function SignIn() {
  const [failed, setFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [demoAccounts, setDemoAccounts] = useState<DemoAccount[]>([]);

  // Someone already signed in has nothing to do here.
  useEffect(() => {
    let current = true;
    void api.session().then((session) => {
      if (current && session.ok) {
        navigate({ name: "schools" }, { replace: true });
      }
    });
    return () => {
      current = false;
    };
  }, []);

  // Only the public demo publishes any. Anywhere else, and if the request
  // fails, there are none, and the page is the plain sign-in form.
  useEffect(() => {
    let current = true;
    void api.demo().then((demo) => {
      if (current && demo.ok) {
        setDemoAccounts(demo.body.accounts);
      }
    });
    return () => {
      current = false;
    };
  }, []);

  const signIn = async (credentials: { username: string; password: string }) => {
    setSubmitting(true);
    const result = await api.signIn(credentials);
    setSubmitting(false);
    if (result.ok) {
      navigate({ name: "schools" }, { replace: true });
    } else {
      setFailed(true);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void signIn({
      username: String(form.get("username") ?? ""),
      password: String(form.get("password") ?? ""),
    });
  };

  const legend = (
    <>
      <h2>Key</h2>
      <p>Signing in to SchoolGrid.</p>
      <dl>
        <Key term="User account">
          One User account, which may reach more than one School. It holds no role and no academic record of its own.
        </Key>
        <Key term="Refusals">
          Every refused sign-in is answered the same way, whatever went wrong. Nothing here says which.
        </Key>
      </dl>
    </>
  );

  return (
    <Sheet
      name="Sign in"
      legend={legend}
      foot={
        <p className="muted">
          <Link to={{ name: "howThisWasBuilt" }}>
            How this was built
          </Link>
        </p>
      }
    >
      <h1>Sign in to SchoolGrid</h1>
      {/*
        What the visitor is signing in to, before they are asked for anything.
        Said in the glossary's own terms, because those are the words every
        sheet beyond this one is struck in.
      */}
      <p>
        SchoolGrid is a K-12 academic records system for a School. One School owns its Persons, its
        Class Offerings and every record about them, and nothing is shared between Schools.
      </p>
      <p>
        One User account signs in here. It holds no role of its own: what it reaches is whichever Person
        it resolves to in each School, and the School memberships that Person holds.
      </p>
      <form onSubmit={submit}>
        <label>
          Username
          <input name="username" autoComplete="username" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        {/*
          One message whatever went wrong: an unknown username, a wrong
          password, a throttled attempt or a server error. The API refuses the
          first two alike (ADR-0002), and the page does not tell any of them
          apart, so it cannot explain a refusal the API did not.
        */}
        {failed && (
          <p role="alert" className="error">
            Sign-in did not work. Check your details and try again.
          </p>
        )}
        <button type="submit" disabled={submitting}>
          Sign in
        </button>
      </form>
      {demoAccounts.length > 0 && (
        <section className="demo" aria-labelledby="try-a-role">
          <h2 id="try-a-role">Try a role</h2>
          <p>
            Each role sees a different part of the same School. Pick one to sign in as, and the sheets
            that follow are the ones that role reaches.
          </p>
          <p className="muted">
            Every Person, Class Offering and record in this demo is invented. Anyone can change any of it,
            and all of it resets every night.
          </p>
          <ul className="roles">
            {demoAccounts.map((account) => (
              <li key={account.role}>
                <button
                  type="button"
                  className="button-ghost"
                  disabled={submitting}
                  // The role's line is read out with the button rather than
                  // left beside it, so the perspective on offer reaches a
                  // screen reader as part of the choice.
                  aria-describedby={seesId(account.role)}
                  onClick={() => void signIn({ username: account.username, password: account.password })}
                >
                  Sign in as {ROLE_NAMES[account.role]}
                </button>
                <p className="roles__sees" id={seesId(account.role)}>
                  {ROLE_SEES[account.role]}
                </p>
                <p className="muted roles__account">
                  {account.username} / {account.password}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Sheet>
  );
}
