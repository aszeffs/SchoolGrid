import { useEffect, useState, type FormEvent, type MouseEvent } from "react";
import { api, type DemoAccount } from "./api.ts";
import { navigate } from "./navigation.ts";
import { Key, Sheet } from "./Sheet.tsx";

/** Each School role as the demo's panel names it. */
const ROLE_NAMES: Record<DemoAccount["role"], string> = {
  school_administrator: "School Administrator",
  faculty: "Faculty",
  student: "Student",
  guardian: "Guardian",
};

export function SignIn() {
  const [failed, setFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [demoAccounts, setDemoAccounts] = useState<DemoAccount[]>([]);

  // Someone already signed in has nothing to do here.
  useEffect(() => {
    let current = true;
    void api.session().then((session) => {
      if (current && session.ok) {
        navigate("/", { replace: true });
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
      navigate("/", { replace: true });
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

  const howThisWasBuilt = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    navigate("/how-this-was-built");
  };

  const legend = (
    <>
      <h2>This sheet</h2>
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
      stock="canary"
      name="Sign in"
      legend={legend}
      foot={
        <p className="muted">
          <a href="/how-this-was-built" onClick={howThisWasBuilt}>
            How this was built
          </a>
        </p>
      }
    >
      <h1>Sign in to SchoolGrid</h1>
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
          <p className="muted">
            This is a demo holding invented data only. Anyone can change it, and it resets every night.
          </p>
          <ul>
            {demoAccounts.map((account) => (
              <li key={account.role}>
                <button
                  type="button"
                  className="button-ghost"
                  disabled={submitting}
                  onClick={() => void signIn({ username: account.username, password: account.password })}
                >
                  Sign in as {ROLE_NAMES[account.role]}
                </button>
                <span className="muted">
                  {account.username} / {account.password}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Sheet>
  );
}
